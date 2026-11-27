package main

import (
	"encoding/binary"
	"math"
)

const samplesPerFrame = speechFrameBytes / 2

// Sample several frequencies in each speech band. The Goertzel recurrence
// measures only the selected bins of the 20 ms frame (50 Hz per bin).
var bandCoefficients = func() [12][]float64 {
	bins := [12][]int{
		{1, 2}, {3, 4}, {5, 6, 7}, {8, 9, 10}, {11, 13, 15}, {16, 19, 22},
		{23, 27, 31}, {32, 38, 44}, {45, 53, 62}, {63, 76, 89}, {90, 107, 124}, {125, 142, 159},
	}
	var coefficients [12][]float64
	for band, frequencies := range bins {
		for _, frequency := range frequencies {
			coefficients[band] = append(coefficients[band], 2*math.Cos(2*math.Pi*float64(frequency)/samplesPerFrame))
		}
	}
	return coefficients
}()

var hannWindow = func() [samplesPerFrame]float64 {
	var window [samplesPerFrame]float64
	for i := range window {
		window[i] = (0.5 - 0.5*math.Cos(2*math.Pi*float64(i)/(samplesPerFrame-1))) / samplesPerFrame
	}
	return window
}()

type bandEnergy [len(bandCoefficients)]float64

func measureBands(pcm []byte) (power bandEnergy) {
	var samples [samplesPerFrame]float64
	for i, weight := range hannWindow {
		value := int16(binary.LittleEndian.Uint16(pcm[2*i:]))
		samples[i] = float64(value) * weight
	}
	for band, coefficients := range bandCoefficients {
		for _, coefficient := range coefficients {
			var last, previous float64
			for _, sample := range samples {
				last, previous = sample+coefficient*last-previous, last
			}
			power[band] += last*last + previous*previous - coefficient*last*previous
		}
		power[band] /= float64(len(coefficients))
	}
	return power
}

// WebRTC VAD also fires on some steady motors. Compare each band's energy to
// the room while keeping the original PCM, including quiet consonants, for STT.
type roomNoise struct {
	floor, sum bandEnergy
	history    [3]bandEnergy
	next, used int
	age, quiet int
	levels     [4]float64
	levelCount int
	motion     int
	amplified  [speechFrameBytes]byte
}

func (r *roomNoise) analyse(pcm []byte, recording bool) (vadInput []byte, speech bool) {
	var square, peak float64
	for i := 0; i < len(pcm); i += 2 {
		value := float64(int16(binary.LittleEndian.Uint16(pcm[i:])))
		square += value * value
		peak = max(peak, math.Abs(value))
	}
	level := math.Sqrt(square / samplesPerFrame)
	vadInput = pcm
	if level < 4 || peak > 10*level {
		r.quiet = min(8, r.quiet+1)
		r.levelCount, r.motion = 0, 0
		return vadInput, false
	}
	current := measureBands(pcm)
	if r.age == 0 || r.quiet >= 8 && !recording {
		*r = roomNoise{floor: current}
	}
	if gain := min(3, 350/level); gain > 1 {
		// Only WebRTC sees the gain. After the crest check above, this
		// gain cannot clip: the amplified peak is below 10 * 350.
		for i := 0; i < len(pcm); i += 2 {
			sample := int16(binary.LittleEndian.Uint16(pcm[i:]))
			binary.LittleEndian.PutUint16(r.amplified[i:], uint16(int16(math.Round(float64(sample)*gain))))
		}
		vadInput = r.amplified[:]
	}
	r.quiet = 0
	r.age = min(10, r.age+1)
	copy(r.levels[:], r.levels[1:])
	r.levels[3] = level
	r.levelCount = min(4, r.levelCount+1)
	if r.levelCount == 4 {
		before, after := r.levels[0]+r.levels[1], r.levels[2]+r.levels[3]
		if max(before, after) > 1.32*min(before, after) {
			r.motion = 9
		} else {
			r.motion = max(0, r.motion-1)
		}
	}
	if r.age == 1 {
		return vadInput, false
	}
	if r.age == 2 {
		for i, value := range current {
			r.floor[i] = (r.floor[i] + value) / 2
		}
		return vadInput, false
	}

	// A 60 ms average smooths random noise. Require energy in the current
	// frame too, so one click cannot cast three successive onset votes.
	r.used = min(len(r.history), r.used+1)
	threshold, strong, rise := 2.8, 6.5, 0.036
	switch {
	case recording:
		threshold, strong, rise = 2.1, 4, 0.005
	case r.age < 10:
		threshold, strong = 4, 9.2
	}
	var rising, instantaneous int
	var sustainedPeak, instantaneousPeak bool
	for i, value := range current {
		r.sum[i] += value - r.history[r.next][i]
		mean := r.sum[i] / float64(r.used)
		// Stabilize ratios around digital silence.
		level := (mean + 0.6) / (r.floor[i] + 0.6)
		now := (value + 0.6) / (r.floor[i] + 0.6)
		if level > threshold {
			rising++
		}
		if now > 2.3 {
			instantaneous++
		}
		sustainedPeak = sustainedPeak || level > strong
		instantaneousPeak = instantaneousPeak || now > 5.5
		delta := mean - r.floor[i]
		if delta < 0 {
			r.floor[i] += 0.042 * delta
		} else {
			r.floor[i] += rise * min(delta, 3*r.floor[i]+2)
		}
	}
	r.history[r.next] = current
	r.next = (r.next + 1) % len(r.history)
	spectral := (rising >= 2 || sustainedPeak) && (instantaneous >= 2 || instantaneousPeak)
	// Quiet syllables can change level without crossing two spectral bands.
	return vadInput, spectral || r.motion > 0 && (recording || level < 350)
}
