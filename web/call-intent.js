export function callIntent(text) {
  const words = text
    .toLocaleLowerCase('de')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const phrase = words.replace(
    /^(?:(?:ja|ok(?:ay)?|gut|passt|alles klar|danke(?: dir| ?schön)?|(?:vielen|besten) dank|nod|na dann|dann|also|bitte|das war ?s(?: für (?:heute|jetzt))?(?= ))(?: |$))+/u,
    '',
  );
  if (!phrase) return 'acknowledgement';
  if (
    /^(?:bis (?:später|bald|dann|morgen|zum nächsten mal)|wir (?:hören|sprechen) (?:uns )?(?:später|morgen|bald)(?: wieder)?|tschüss?|tschau|ciao|auf wiederhören|mach ?s gut|das war ?s(?: für (?:heute|jetzt)| von mir)?|(?:wir sind|ich bin) (?:jetzt )?(?:für heute )?fertig|leg (?:bitte )?(?:jetzt )?auf|du (?:kannst|darfst) (?:jetzt )?auflegen)(?: (?:nod|bitte|danke(?: dir)?|tschüss?))*$/u.test(
      phrase,
    )
  )
    return 'end_call';
  if (
    /^(?:bleibe? (?:bitte )?(?:noch )?(?:kurz )?(?:dran|am telefon|in der leitung)|(?:kannst|könntest|würdest) du (?:bitte )?(?:noch )?(?:kurz )?(?:dran ?bleiben|warten|in der leitung bleiben)|(?:noch )?nicht auflegen|leg (?:bitte )?(?:noch )?nicht auf|warte (?:bitte )?(?:kurz|einen (?:kleinen )?moment))(?: (?:bitte|nod|ich bin gleich (?:wieder da|zurück)))*$/u.test(
      phrase,
    )
  )
    return 'hold_call';
}

export function nativeCallReply(transcript) {
  const callAction = callIntent(transcript);
  if (callAction === 'end_call')
    return { state: 'reply', callAction, text: 'Alles klar, bis dann!' };
  if (callAction === 'hold_call')
    return {
      state: 'reply',
      callAction,
      text: 'Klar, ich bleibe dran. In fünf Minuten frage ich nach.',
    };
}
