FROM golang:1.26-bookworm@sha256:ea47ee45f1284d60f9cc09cb2c3bb4f508c256b640bd8bb30342ff13d1adcb52 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN go test -mod=readonly ./... && go build -mod=readonly -trimpath -o /out/whatsapp-linked .
# Preserve upstream notices next to the module version manifest.
RUN mkdir /out/licenses && go list -m all > /out/licenses/modules.txt && \
    go list -m -f '{{if and (not .Main) .Dir}}{{.Dir}}{{end}}' all | while read -r path; do \
      [ -n "$path" ] || continue; dest="/out/licenses/${path#/go/pkg/mod/}"; mkdir -p "$dest"; \
      find "$path" -maxdepth 1 -type f \( -iname 'license*' -o -iname 'copying*' -o -iname 'notice*' -o -iname 'patents*' \) -exec cp -t "$dest" {} +; \
    done

FROM debian:bookworm-slim@sha256:e67eeead736ff7bbe258ef088bff683635c561b1fcfefad0806c1df4ab49ce0e
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=build /out/licenses/ /usr/share/doc/whatsapp-linked/licenses/
COPY --from=build /out/whatsapp-linked /usr/local/bin/whatsapp-linked
RUN mkdir /session && chown 65532:65532 /session && chmod 0700 /session
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/whatsapp-linked"]
CMD ["run"]
