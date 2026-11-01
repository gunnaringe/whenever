// Strings and date formatting. nb (Norwegian bokmål) is the source and
// defines the keys; en is below it, the other languages are in lang/ (each
// typed Record<Key, Text>, so a missing or extra key doesn't compile).
// t() returns plain text: escape it before putting it in HTML. A value can be
// { one, other }, picked by vars.n (see PLURAL_ONE).

import { toTime, hhmm, parseKey, weekday } from '../shared/model.ts';
import type { TimeWindow } from '../shared/model.ts';
import { da } from './lang/da.ts';
import { is } from './lang/is.ts';
import { nn } from './lang/nn.ts';
import { sv } from './lang/sv.ts';

export type Text = string | { one: string; other: string };

const nb = {
  appName: 'Finn tid',
  tagline: 'finn dagen som passer for flest',
  privacy: 'Personvern',
  sourceCode: 'Kildekode',
  heroTitle: 'Finn tiden som passer for flest',
  heroLead: 'Lag en avtale, velg mulige dager eller klokkeslett og del lenken. Alle markerer når de kan – uten innlogging.',
  newEvent: 'Ny avtale',
  yourEvents: 'Dine avtaler',
  yourEventsHint: 'Huskes bare på denne enheten. Lenkene virker på alle enheter.',
  showAllEvents: 'Vis alle ({n})',
  findLink: 'Finn avtalene dine fra en annen enhet',
  findTitle: 'Finn avtalene dine',
  findLead: 'Skriv e-postadressen du oppga da du laget eller svarte på en avtale. Vi sender en kode til den, og så legges avtalene til på denne enheten.',
  findEmail: 'E-postadresse',
  findSend: 'Send kode',
  findSent: 'Er adressen brukt på en avtale her, kommer det straks en e-post med en kode. Koden virker i 10 minutter.',
  findCode: 'Kode fra e-posten',
  findShow: 'Vis avtalene mine',
  findAgain: 'Send ny kode',
  findOther: 'Bruk en annen adresse',
  findAsked: 'Ba om en ny kode.',
  findFound: { one: 'Fant {n} avtale. Den er lagt til på denne enheten.', other: 'Fant {n} avtaler. De er lagt til på denne enheten.' },
  findNone: 'Fant ingen avtaler med denne adressen.',
  openAdmin: 'Admin',
  openMine: 'Mine svar',
  open: 'Åpne',
  tagAdmin: 'Admin',
  tagAnswered: 'Svart',
  forget: 'Glem på denne enheten',
  step1: 'Velg mulige dager',
  step1Text: 'Datoer, eller klokkeslett på hver dag. Fjern helger og helligdager med ett trykk.',
  step2: 'Del lenken',
  step2Text: 'Én lenke til alle. Hver deltaker får sin egen lenke for å endre svarene.',
  step3: 'Se hva som passer',
  step3Text: 'Dagene og tidene som passer for flest, kommer øverst.',
  loading: 'Laster …',
  pageNotFound: 'Fant ikke siden',
  toHome: 'Til forsiden',
  eventNotFound: 'Fant ikke avtalen',
  eventNotFoundText: 'Den kan være slettet, eller lenken er feil. Avtaler slettes automatisk 30 dager etter siste dato.',
  retry: 'Prøv igjen',
  back: 'Tilbake',
  cancel: 'Avbryt',
  ok: 'OK',
  done: 'Ferdig',
  save: 'Lagre',
  saved: 'Lagret',
  delete: 'Slett',
  deleted: 'Slettet',
  copy: 'Kopier',
  copied: 'Kopiert',
  share: 'Del',
  link: 'Lenke',
  more: 'Mer',
  yes: 'Ja',
  maybe: 'Kanskje',
  no: 'Nei',
  name: 'Navn',
  sum: 'Kan',
  you: 'deg',
  language: 'Språk',

  editEvent: 'Endre avtalen',
  aboutEvent: 'Om avtalen',
  eventName: 'Navn på avtalen',
  eventNamePh: 'For eksempel «Julebord»',
  descriptionOptional: 'Beskrivelse (valgfritt)',
  locationOptional: 'Sted (valgfritt)',
  whatToFind: 'Hva skal dere finne?',
  'mode.dates': 'Dager',
  'mode.datesHint': 'Hvilke dager passer?',
  'mode.times': 'Klokkeslett',
  'mode.timesHint': 'Hvilke tider passer, dag for dag?',
  fromHour: 'Fra kl.',
  toHour: 'Til kl.',
  slotLength: 'Ruter på',
  meetingLength: 'Møtet varer',
  timeZone: 'Tidssone',
  timeZoneHint: 'Alle ser tidene i denne tidssonen.',
  possibleDays: 'Mulige dager',
  theme: 'Tema',
  'theme.auto': 'Automatisk',
  'theme.autoHint': 'Lys eller mørk, som enheten',
  'theme.light': 'Lys',
  'theme.dark': 'Mørk',
  'theme.hacker': 'Hacker',
  rangeHint: 'Dra fra én dag til en annen for å ta med alle dagene mellom, eller klikk den første og shift-klikk den siste.',
  rangeHintTouch: 'Hold fingeren på en dag og dra til en annen for å ta med alle dagene mellom.',
  possibleDaysHint: 'Trykk på dagene som kan passe, eller velg flere med knappene. Knappene endrer bare utvalget – du kan fortsatt legge til eller fjerne enkeltdager etterpå.',
  period2w: 'Neste 2 uker',
  period4w: 'Neste 4 uker',
  periodMonth: 'Hele {month}',
  periodHint: 'Velger akkurat disse dagene (i stedet for dem du har valgt)',
  moreMonths: 'Vis neste måned',
  selNone: 'Ingen',
  weekdays: 'Hverdager',
  weekends: 'Helger',
  holidays: 'Helligdager',
  weekdaysHint: 'Fjern de valgte hverdagene (mandag–fredag), eller velg alle i kalenderen',
  weekendsHint: 'Fjern de valgte lørdagene og søndagene, eller velg alle i kalenderen',
  holidaysHint: 'Fjern de valgte helligdagene, eller velg alle helligdagene i kalenderen',
  weekdayHint: 'Fjern de valgte {day}ene, eller velg alle i kalenderen',
  toggleWeek: 'Velg eller fjern uke {n}',
  weekShort: 'U',
  nDays: { one: '1 dag valgt', other: '{n} dager valgt' },
  nSlots: { one: '1 tidsrute', other: '{n} tidsruter' },
  nDaysNoTimes: { one: '1 dag uten tider', other: '{n} dager uten tider' },
  possibleTimes: 'Mulige tider',
  possibleTimesHint: 'Dra over rutene for å markere eller fjerne tider. Trykk på en dag øverst for flere valg.',
  possibleTimesHintTouch: 'Trykk på en rute for å markere eller fjerne den, eller hold fingeren på en rute og dra over flere. Trykk på en dag øverst for flere valg.',
  'preset.all': 'Hele dagen',
  'preset.work': 'Arbeidstid 9–17',
  'preset.evening': 'Kveld 17–22',
  'preset.clear': 'Ingen tider',
  pickDaysFirst: 'Velg dager i kalenderen først.',
  dayAll: 'Velg hele dagen',
  dayClear: 'Fjern alle tider denne dagen',
  dayCopy: 'Bruk disse tidene på alle dager',
  dayCopyHint: 'Dager du legger til senere, får også disse tidene',
  dayRemove: 'Fjern dagen',
  settings: 'Innstillinger',
  'set.maybe': 'Tillat «kanskje»',
  'set.maybeHint': 'Deltakerne kan svare «kan hvis det må til».',
  'set.maybeCounts': '«Kanskje» teller som at de kan',
  'set.maybeCountsHint': 'Rangeringen teller alle som kan eller kanskje kan. Ellers teller bare ja, og ved likt antall ja står den med flest «kanskje» først.',
  'set.openEdit': 'Alle kan endre og slette svar',
  'set.openEditHint': 'Alle med avtalelenken kan endre eller slette alle svarene. Ellers er det bare den som svarte, og du.',
  'set.hidden': 'Skjul svarene for deltakerne',
  'set.hiddenHint': 'Bare du ser hvem som har svart hva.',
  'set.closed': 'Stengt for nye svar',
  'set.closedHint': 'Ingen kan legge til eller endre svar, bortsett fra deg.',
  yourEmailOptional: 'Din e-post (valgfritt)',
  addDetails: 'Legg til beskrivelse og sted',
  manyWeeks: 'Deltakerne må gå gjennom {n} uker med tider, én uke om gangen på mobil. Færre dager gjør det raskere å svare.',
  emailOptional: 'E-post (valgfritt)',
  addEmail: 'Legg til e-post',
  adminEmailHint: 'Lagres med avtalen, så du kan finne avtalen igjen på en annen enhet (vi sender deg en kode). Ingen andre ser den.',
  createEvent: 'Lag avtale',
  saveChanges: 'Lagre endringer',
  lostAnswers: {
    one: '1 svar gjelder dager eller tider som fjernes, og blir slettet.',
    other: '{n} svar gjelder dager eller tider som fjernes, og blir slettet.',
  },
  saveAnyway: 'Lagre likevel',

  createdTitle: 'Avtalen er klar!',
  createdText: 'Del avtalelenken med dem du vil invitere. Admin-lenken er din: ta vare på den, for det er med den du endrer avtalen.',
  savedNewTitle: 'Takk, {name}! Svarene er lagret.',
  savedNewText: 'Dette er din personlige lenke. Med den kan du endre svarene senere, fra hvilken som helst enhet.',
  savedNewHint: 'Ta vare på lenken: legg den til som bokmerke eller send den til deg selv. Ikke del den – den som har lenken, kan endre svarene dine.',
  yourLink: 'Din personlige lenke',
  linkInvalid: 'Denne lenken virker ikke lenger. Den kan være byttet ut med en ny, eller svaret er slettet. Du ser avtalen som gjest.',
  storedAdmin: 'Du er admin for denne avtalen på denne enheten.',
  storedMine: 'Du har svart på denne avtalen fra denne enheten.',
  closedInfo: 'Avtalen er stengt for nye svar.',
  closedAdmin: 'Avtalen er stengt. Bare du kan legge til eller endre svar.',
  metaDates: { one: '1 mulig dag', other: '{n} mulige dager' },
  metaTimes: 'Klokkeslett · møtet varer {dur}',
  timesIn: 'Tider i {tz}',
  yourTz: '(du er i {tz})',
  metaHidden: 'Bare den som laget avtalen, ser svarene',
  metaOpenEdit: 'Alle kan endre svarene',
  youAreAdmin: 'Du er admin',
  adminHint: 'Du kan endre avtalen og alle svarene.',
  addAnswers: 'Legg til svar',
  close: 'Steng',
  reopen: 'Åpne igjen',
  hiName: 'Hei, {name}!',
  personalHint: 'Dette er din personlige lenke. Bruk den når du vil endre svarene.',
  editYourAnswers: 'Endre svarene dine',
  copyMyLink: 'Kopier lenken min',
  shareEvent: 'Del avtalen',
  addYourAnswers: 'Legg til dine svar',
  shareTitle: 'Del avtalen',
  shareHint: 'Send denne lenken til alle som skal være med.',
  eventLink: 'Avtalelenke',
  adminLinkTitle: 'Admin-lenken din',
  adminLinkHint: 'Bare for deg. Med den kan du endre avtalen og alle svarene.',
  qrTitle: 'QR-kode for avtalen',
  resultsTitle: 'Hva passer best?',
  noAnswersYet: 'Ingen har svart ennå.',
  noneAvailable: 'Ingen av alternativene passer for noen ennå.',
  hiddenInfo: {
    one: '1 har svart. Svarene er skjult: bare den som laget avtalen, ser dem.',
    other: '{n} har svart. Svarene er skjult: bare den som laget avtalen, ser dem.',
  },
  'tab.cal': 'Kalender',
  'tab.list': 'Liste',
  'tab.table': 'Tabell',
  'tab.grid': 'Rutenett',
  legendFew: 'Få kan',
  legendMany: 'Mange kan',
  legendTop: 'Flest kan',
  tapForDetails: 'Trykk på et alternativ for å se hvem som kan.',
  tapCellForDetails: 'Trykk på en rute for å se hvem som kan.',
  nOfM: '{n} av {m} kan',
  decidedTitle: 'Avtalt',
  decidedTag: 'Valgt',
  decidedThis: 'Dette er valgt',
  decideThis: 'Velg {when}',
  decideQ: 'Velge {when}? Alle som åpner avtalen ser valget, og avtalen stenges for nye svar.',
  decideOk: 'Velg',
  decidedToast: 'Valgt. Del lenken, så ser alle det.',
  undecideQ: 'Angre valget? Avtalen forblir stengt til du åpner den igjen.',
  undoDecision: 'Angre valget',
  undecidedToast: 'Valget er angret',
  addToCalendar: 'Legg i kalender',
  nMaybe: { one: '1 kanskje', other: '{n} kanskje' },
  nMaybeIncl: { one: 'inkl. 1 kanskje', other: 'inkl. {n} kanskje' },
  moreTied: { one: 'Vis 1 til med like mange som kan', other: 'Vis {n} til med like mange som kan' },
  showFewer: 'Vis færre',
  rankYesFirst: 'Rangert etter flest ja. Ved likt antall står den med flest «kanskje» først.',
  rankMaybeCounts: 'Rangert etter flest som kan, «kanskje» medregnet. Ved likt antall står den med flest ja først.',
  canCome: 'Kan',
  ifNeedBe: 'Kanskje',
  cannot: 'Kan ikke',
  responses: 'Svar',
  hiddenPeople: 'Svarene er skjult. Du ser bare ditt eget.',
  sumYes: 'Kan {n} av {m}',
  sumYesTime: 'Kan {dur}',
  maybeDur: 'kanskje {dur}',
  sumNoneDates: 'Kan ingen av dagene',
  sumNoneTimes: 'Kan ingen av tidene',
  copyPersonLink: 'Lenken til {name}',
  deleteEntry: 'Slett svaret til {name}',
  expiresNote: 'Avtalen slettes automatisk {date}.',
  adminMenu: 'Admin',
  newAdminLink: 'Ny admin-lenke',
  newAdminLinkHint: 'Den gamle slutter å virke',
  newAdminLinkQ: 'Lage en ny admin-lenke? Den gamle slutter å virke med en gang.',
  makeNewLink: 'Lag ny lenke',
  newLinkDone: 'Ny lenke',
  newAdminLinkDoneText: 'Dette er den nye admin-lenken. Den gamle virker ikke lenger.',
  deleteEvent: 'Slett avtalen',
  deleteEventHint: 'Sletter alt, også alle svarene',
  deleteEventQ: 'Slette avtalen og alle svarene? Det kan ikke angres.',
  eventDeleted: 'Avtalen er slettet',
  meMenu: 'Svarene dine',
  newMyLink: 'Ny personlig lenke',
  newMyLinkHint: 'Den gamle slutter å virke',
  newMyLinkQ: 'Lage en ny personlig lenke? Den gamle slutter å virke med en gang.',
  newMyLinkDoneText: 'Dette er din nye personlige lenke. Den gamle virker ikke lenger.',
  deleteMine: 'Slett svarene mine',
  deleteMineQ: 'Slette svarene dine?',
  deleteEntryQ: 'Slette svaret til {name}?',
  personLinkTitle: 'Lenken til {name}',
  personLinkText: 'Den som har denne lenken, kan endre svarene. Send den bare til personen det gjelder.',
  addedByAdminText: 'Svaret er lagt til. Med denne lenken kan personen endre svarene selv senere.',
  closedToast: 'Avtalen er stengt',
  reopenedToast: 'Avtalen er åpnet igjen',

  editAnswersOf: 'Endre svarene til {name}',
  yourName: 'Navnet ditt',
  emailHint: 'Lagres med svaret, så du kan finne avtalen igjen på en annen enhet (vi sender deg en kode). Ingen andre ser den.',
  commentOptional: 'Kommentar (valgfritt)',
  commentPh: 'For eksempel «Kan bare etter kl. 18»',
  whichDays: 'Hvilke dager passer?',
  whichTimes: 'Hvilke tider passer?',
  answerDatesHint: 'Trykk på dagene du kan.',
  answerDatesHintMaybe: 'Trykk én gang for «ja», to ganger for «kanskje» og tre ganger for å fjerne.',
  answerTimesHint: 'Dra over tidene du kan. Dra fra en markert rute for å fjerne. Trykk på en dag øverst for å svare for hele dagen.',
  answerTimesHintMaybe: 'Velg «Kan» eller «Kanskje» og dra over tidene. Dra fra en markert rute for å fjerne. Trykk på en dag øverst for å svare for hele dagen.',
  answerTimesHintTouch: 'Trykk på tidene du kan, eller hold fingeren på en rute og dra over flere. Start på en markert rute for å fjerne. Trykk på en dag øverst for å svare for hele dagen.',
  answerTimesHintTouchMaybe: 'Velg «Kan» eller «Kanskje» og trykk på tidene, eller hold fingeren på en rute og dra over flere. Start på en markert rute for å fjerne. Trykk på en dag øverst for å svare for hele dagen.',
  brush: 'Marker som',
  yesToAll: 'Ja til alle',
  clearAll: 'Nullstill',
  dayYes: 'Kan hele dagen',
  dayMaybe: 'Kanskje hele dagen',
  dayNone: 'Kan ikke denne dagen',
  pickSumDates: 'Du kan {n} av {m} dager',
  pickSumTimes: 'Du kan {dur}',
  pickSumNone: 'Ingenting markert ennå',
  discardQ: 'Forkaste endringene?',
  discard: 'Forkast',

  weeks: 'Uker',
  weekN: 'Uke {n}',
  weekRange: 'Uke {a}–{b}',
  weekPair: 'Uke {a} og {b}',
  gridPaintLabel: 'Tider. Piltastene flytter, mellomrom markerer.',
  gridViewLabel: 'Oversikt over tidene',

  'err.network': 'Fikk ikke kontakt med serveren. Sjekk nettet og prøv igjen.',
  'err.rate': 'For mange forespørsler. Vent litt og prøv igjen.',
  'err.notFound': 'Fant ikke avtalen.',
  'err.forbidden': 'Du har ikke lov til å gjøre dette.',
  'err.closed': 'Avtalen er stengt for nye svar.',
  'err.full': 'Avtalen har fått så mange svar som den kan ta.',
  'err.person': 'Fant ikke svaret. Det kan være slettet.',
  'err.personName': 'Skriv inn navnet ditt.',
  'err.email': 'E-postadressen ser ikke riktig ut.',
  'err.code': 'Koden er feil eller utløpt.',
  'err.wait.minute': 'Du ba nettopp om en kode. Vent et minutt før du ber om en ny.',
  'err.wait.hour': 'Du har bedt om flere koder. Prøv igjen om en time.',
  'err.wait.day': 'Grensen for koder i dag er nådd. Prøv igjen i morgen.',
  'err.mail': 'Vi kan ikke sende e-post akkurat nå. Prøv igjen senere.',
  'err.name': 'Gi avtalen et navn.',
  'err.range': 'Ugyldige datoer.',
  'err.rangeLong': 'Det kan være høyst ett år fra første til siste dag.',
  'err.rangeLongTimes': 'Med klokkeslett kan det være høyst 62 dager fra første til siste dag.',
  'err.hours': 'Velg et gyldig tidsrom.',
  'err.options': 'Velg minst én mulig dag eller tid.',
  'err.tooMany': 'For mange mulige tider (høyst 2000). Velg færre dager eller lengre ruter.',
  'err.server': 'Noe gikk galt. Prøv igjen.',

  'holiday.newYear': '1. nyttårsdag',
  'holiday.maundyThursday': 'Skjærtorsdag',
  'holiday.goodFriday': 'Langfredag',
  'holiday.easter': '1. påskedag',
  'holiday.easterMonday': '2. påskedag',
  'holiday.mayDay': 'Arbeidernes dag',
  'holiday.constitutionDay': 'Grunnlovsdagen',
  'holiday.ascension': 'Kristi himmelfartsdag',
  'holiday.whitsun': '1. pinsedag',
  'holiday.whitMonday': '2. pinsedag',
  'holiday.christmas': '1. juledag',
  'holiday.boxingDay': '2. juledag',
  'holiday.christmasEve': 'Julaften',
  'holiday.newYearsEve': 'Nyttårsaften',
  'holiday.epiphany': 'Hellige tre kongers dag',
  'holiday.nationalDaySe': 'Sveriges nasjonaldag',
  'holiday.midsummerEve': 'Midtsommeraften',
  'holiday.midsummerDay': 'Midtsommerdagen',
  'holiday.allSaints': 'Allehelgensdag',
  'holiday.greatPrayerDay': 'Store bededag',
  holidayCal: 'Helligdager i kalenderen',
  holidayCalHint: 'Helligdagene får en prikk, og knappen «Helligdager» velger dem. Julaften og nyttårsaften er med, i Sverige også midtsommeraften.',
  'holidayCal.no': 'Norge',
  'holidayCal.se': 'Sverige',
  'holidayCal.dk': 'Danmark',
  'holidayCal.none': 'Ingen',
} satisfies Record<string, Text>;

export type Key = keyof typeof nb;
export type Lang = 'nb' | 'nn' | 'sv' | 'da' | 'is' | 'en';

// Record<Key, …>: a key missing in English (or extra) doesn't compile.
const en: Record<Key, Text> = {
  appName: 'Whenever',
  tagline: 'find the day that suits most people',
  privacy: 'Privacy',
  sourceCode: 'Source code',
  heroTitle: 'Find the time that suits most people',
  heroLead: 'Make an event, pick the possible days or times and share the link. Everyone marks when they can – no sign-up.',
  newEvent: 'New event',
  yourEvents: 'Your events',
  yourEventsHint: 'Only remembered on this device. The links work on any device.',
  showAllEvents: 'Show all ({n})',
  findLink: 'Find your events from another device',
  findTitle: 'Find your events',
  findLead: 'Enter the email address you gave when you made or answered an event. We’ll send a code to it, and the events are then added to this device.',
  findEmail: 'Email address',
  findSend: 'Send code',
  findSent: 'If the address has been used on an event here, an email with a code is on its way. The code works for 10 minutes.',
  findCode: 'Code from the email',
  findShow: 'Show my events',
  findAgain: 'Send a new code',
  findOther: 'Use another address',
  findAsked: 'Asked for a new code.',
  findFound: { one: 'Found {n} event. It’s been added to this device.', other: 'Found {n} events. They’ve been added to this device.' },
  findNone: 'No events found for this address.',
  openAdmin: 'Admin',
  openMine: 'My answers',
  open: 'Open',
  tagAdmin: 'Admin',
  tagAnswered: 'Answered',
  forget: 'Forget on this device',
  step1: 'Pick the possible days',
  step1Text: 'Dates, or times on each day. Drop weekends and holidays with one tap.',
  step2: 'Share the link',
  step2Text: 'One link for everyone. Each person gets their own link to change their answers.',
  step3: 'See what works',
  step3Text: 'The days and times that suit most people come first.',
  loading: 'Loading …',
  pageNotFound: 'Page not found',
  toHome: 'Go to the start page',
  eventNotFound: 'Event not found',
  eventNotFoundText: 'It may have been deleted, or the link is wrong. Events are deleted automatically 30 days after their last date.',
  retry: 'Try again',
  back: 'Back',
  cancel: 'Cancel',
  ok: 'OK',
  done: 'Done',
  save: 'Save',
  saved: 'Saved',
  delete: 'Delete',
  deleted: 'Deleted',
  copy: 'Copy',
  copied: 'Copied',
  share: 'Share',
  link: 'Link',
  more: 'More',
  yes: 'Yes',
  maybe: 'Maybe',
  no: 'No',
  name: 'Name',
  sum: 'Can',
  you: 'you',
  language: 'Language',

  editEvent: 'Edit event',
  aboutEvent: 'About the event',
  eventName: 'Event name',
  eventNamePh: 'For example “Christmas party”',
  descriptionOptional: 'Description (optional)',
  locationOptional: 'Location (optional)',
  whatToFind: 'What are you looking for?',
  'mode.dates': 'Days',
  'mode.datesHint': 'Which days work?',
  'mode.times': 'Times',
  'mode.timesHint': 'Which times work, day by day?',
  fromHour: 'From',
  toHour: 'To',
  slotLength: 'Slots of',
  meetingLength: 'Meeting length',
  timeZone: 'Time zone',
  timeZoneHint: 'Everyone sees the times in this time zone.',
  possibleDays: 'Possible days',
  theme: 'Theme',
  'theme.auto': 'Automatic',
  'theme.autoHint': 'Light or dark, like your device',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.hacker': 'Hacker',
  rangeHint: 'Drag from one day to another to include every day in between, or click the first and shift-click the last.',
  rangeHintTouch: 'Hold your finger on a day and drag to another to include every day in between.',
  possibleDaysHint: 'Tap the days that could work, or pick several with the buttons. The buttons only change the selection – you can still add or drop single days afterwards.',
  period2w: 'Next 2 weeks',
  period4w: 'Next 4 weeks',
  periodMonth: 'All of {month}',
  periodHint: 'Picks exactly these days (instead of the ones you picked)',
  moreMonths: 'Show next month',
  selNone: 'None',
  weekdays: 'Weekdays',
  weekends: 'Weekends',
  holidays: 'Holidays',
  weekdaysHint: 'Drop the picked weekdays (Monday–Friday), or pick all of them in the calendar',
  weekendsHint: 'Drop the picked Saturdays and Sundays, or pick all of them in the calendar',
  holidaysHint: 'Drop the picked public holidays, or pick all of them in the calendar',
  weekdayHint: 'Drop the picked {day}s, or pick all of them in the calendar',
  toggleWeek: 'Pick or drop week {n}',
  weekShort: 'Wk',
  nDays: { one: '1 day picked', other: '{n} days picked' },
  nSlots: { one: '1 time slot', other: '{n} time slots' },
  nDaysNoTimes: { one: '1 day without times', other: '{n} days without times' },
  possibleTimes: 'Possible times',
  possibleTimesHint: 'Drag across the slots to mark or clear times. Tap a day at the top for more options.',
  possibleTimesHintTouch: 'Tap a slot to mark or clear it, or hold your finger on a slot and drag across more. Tap a day at the top for more options.',
  'preset.all': 'All day',
  'preset.work': 'Working hours 9–17',
  'preset.evening': 'Evenings 17–22',
  'preset.clear': 'No times',
  pickDaysFirst: 'Pick days in the calendar first.',
  dayAll: 'Pick the whole day',
  dayClear: 'Clear all times on this day',
  dayCopy: 'Use these times on every day',
  dayCopyHint: 'Days you add later get these times too',
  dayRemove: 'Remove the day',
  settings: 'Settings',
  'set.maybe': 'Allow “maybe”',
  'set.maybeHint': 'People can answer “if need be”.',
  'set.maybeCounts': 'Count “maybe” as able to come',
  'set.maybeCountsHint': 'Rank by everyone who can or maybe can. Otherwise only yes counts, and on a tie the one with more “maybe” comes first.',
  'set.openEdit': 'Everyone can edit and delete answers',
  'set.openEditHint': 'Anyone with the event link can change or delete every answer. Otherwise only the person who answered, and you.',
  'set.hidden': 'Hide answers from participants',
  'set.hiddenHint': 'Only you see who answered what.',
  'set.closed': 'Closed for new answers',
  'set.closedHint': 'Nobody but you can add or change answers.',
  yourEmailOptional: 'Your email (optional)',
  addDetails: 'Add a description and place',
  manyWeeks: 'Participants have to go through {n} weeks of times, one week at a time on a phone. Fewer days make it quicker to answer.',
  emailOptional: 'Email (optional)',
  addEmail: 'Add your email',
  adminEmailHint: 'Stored with the event, so you can find the event again on another device (we’ll email you a code). Nobody else sees it.',
  createEvent: 'Create event',
  saveChanges: 'Save changes',
  lostAnswers: {
    one: '1 answer is for days or times being removed and will be deleted.',
    other: '{n} answers are for days or times being removed and will be deleted.',
  },
  saveAnyway: 'Save anyway',

  createdTitle: 'Your event is ready!',
  createdText: 'Share the event link with the people you invite. The admin link is yours: keep it, it’s how you change the event.',
  savedNewTitle: 'Thanks, {name}! Your answers are saved.',
  savedNewText: 'This is your personal link. Use it to change your answers later, from any device.',
  savedNewHint: 'Keep the link: bookmark it or send it to yourself. Don’t share it – whoever has it can change your answers.',
  yourLink: 'Your personal link',
  linkInvalid: 'This link no longer works. It may have been replaced by a new one, or the answers were deleted. You’re seeing the event as a guest.',
  storedAdmin: 'You’re the admin of this event on this device.',
  storedMine: 'You answered this event from this device.',
  closedInfo: 'This event is closed for new answers.',
  closedAdmin: 'This event is closed. Only you can add or change answers.',
  metaDates: { one: '1 possible day', other: '{n} possible days' },
  metaTimes: 'Times · the meeting lasts {dur}',
  timesIn: 'Times in {tz}',
  yourTz: '(you’re in {tz})',
  metaHidden: 'Only the organiser sees the answers',
  metaOpenEdit: 'Everyone can edit the answers',
  youAreAdmin: 'You’re the admin',
  adminHint: 'You can change the event and every answer.',
  addAnswers: 'Add answers',
  close: 'Close',
  reopen: 'Reopen',
  hiName: 'Hi, {name}!',
  personalHint: 'This is your personal link. Use it when you want to change your answers.',
  editYourAnswers: 'Change your answers',
  copyMyLink: 'Copy my link',
  shareEvent: 'Share the event',
  addYourAnswers: 'Add your answers',
  shareTitle: 'Share the event',
  shareHint: 'Send this link to everyone who’s invited.',
  eventLink: 'Event link',
  adminLinkTitle: 'Your admin link',
  adminLinkHint: 'Just for you. It lets you change the event and every answer.',
  qrTitle: 'QR code for the event',
  resultsTitle: 'What works best?',
  noAnswersYet: 'Nobody has answered yet.',
  noneAvailable: 'None of the options work for anyone yet.',
  hiddenInfo: {
    one: '1 person has answered. The answers are hidden: only the organiser sees them.',
    other: '{n} people have answered. The answers are hidden: only the organiser sees them.',
  },
  'tab.cal': 'Calendar',
  'tab.list': 'List',
  'tab.table': 'Table',
  'tab.grid': 'Grid',
  legendFew: 'Few can',
  legendMany: 'Many can',
  legendTop: 'Most can',
  tapForDetails: 'Tap an option to see who can come.',
  tapCellForDetails: 'Tap a slot to see who can come.',
  nOfM: '{n} of {m} can',
  decidedTitle: 'Decided',
  decidedTag: 'Picked',
  decidedThis: 'This is the pick',
  decideThis: 'Pick {when}',
  decideQ: 'Pick {when}? Everyone who opens the event sees it, and the event closes for new answers.',
  decideOk: 'Pick',
  decidedToast: 'Picked. Share the link and everyone sees it.',
  undecideQ: 'Undo the pick? The event stays closed until you reopen it.',
  undoDecision: 'Undo the pick',
  undecidedToast: 'The pick is undone',
  addToCalendar: 'Add to calendar',
  nMaybe: { one: '1 maybe', other: '{n} maybe' },
  nMaybeIncl: { one: 'incl. 1 maybe', other: 'incl. {n} maybe' },
  moreTied: { one: 'Show 1 more with as many able to come', other: 'Show {n} more with as many able to come' },
  showFewer: 'Show fewer',
  rankYesFirst: 'Ranked by most yes. On a tie, the one with more “maybe” comes first.',
  rankMaybeCounts: 'Ranked by most who can come, counting “maybe”. On a tie, the one with more yes comes first.',
  canCome: 'Can',
  ifNeedBe: 'Maybe',
  cannot: 'Can’t',
  responses: 'Answers',
  hiddenPeople: 'The answers are hidden. You only see your own.',
  sumYes: 'Can do {n} of {m}',
  sumYesTime: 'Can do {dur}',
  maybeDur: 'maybe {dur}',
  sumNoneDates: 'None of the days work',
  sumNoneTimes: 'None of the times work',
  copyPersonLink: 'Link for {name}',
  deleteEntry: 'Delete the answers from {name}',
  expiresNote: 'This event is deleted automatically on {date}.',
  adminMenu: 'Admin',
  newAdminLink: 'New admin link',
  newAdminLinkHint: 'The old one stops working',
  newAdminLinkQ: 'Make a new admin link? The old one stops working right away.',
  makeNewLink: 'Make a new link',
  newLinkDone: 'New link',
  newAdminLinkDoneText: 'This is your new admin link. The old one no longer works.',
  deleteEvent: 'Delete the event',
  deleteEventHint: 'Deletes everything, including all answers',
  deleteEventQ: 'Delete the event and every answer? This can’t be undone.',
  eventDeleted: 'The event was deleted',
  meMenu: 'Your answers',
  newMyLink: 'New personal link',
  newMyLinkHint: 'The old one stops working',
  newMyLinkQ: 'Make a new personal link? The old one stops working right away.',
  newMyLinkDoneText: 'This is your new personal link. The old one no longer works.',
  deleteMine: 'Delete my answers',
  deleteMineQ: 'Delete your answers?',
  deleteEntryQ: 'Delete the answers from {name}?',
  personLinkTitle: 'Link for {name}',
  personLinkText: 'Whoever has this link can change these answers. Only send it to the person it belongs to.',
  addedByAdminText: 'The answers were added. With this link the person can change them later.',
  closedToast: 'The event is closed',
  reopenedToast: 'The event is open again',

  editAnswersOf: 'Change the answers from {name}',
  yourName: 'Your name',
  emailHint: 'Stored with your answers, so you can find the event again on another device (we’ll email you a code). Nobody else sees it.',
  commentOptional: 'Comment (optional)',
  commentPh: 'For example “Only after 6 pm”',
  whichDays: 'Which days work for you?',
  whichTimes: 'Which times work for you?',
  answerDatesHint: 'Tap the days you can make.',
  answerDatesHintMaybe: 'Tap once for “yes”, twice for “maybe” and three times to clear.',
  answerTimesHint: 'Drag across the times you can make. Start on a marked slot to clear. Tap a day at the top to answer for the whole day.',
  answerTimesHintMaybe: 'Choose “Can” or “Maybe” and drag across the times. Start on a marked slot to clear. Tap a day at the top to answer for the whole day.',
  answerTimesHintTouch: 'Tap the times you can make, or hold your finger on a slot and drag across more. Start on a marked slot to clear. Tap a day at the top to answer for the whole day.',
  answerTimesHintTouchMaybe: 'Choose “Can” or “Maybe” and tap the times, or hold your finger on a slot and drag across more. Start on a marked slot to clear. Tap a day at the top to answer for the whole day.',
  brush: 'Mark as',
  yesToAll: 'Yes to all',
  clearAll: 'Clear',
  dayYes: 'Can all day',
  dayMaybe: 'Maybe all day',
  dayNone: 'Can’t this day',
  pickSumDates: 'You can do {n} of {m} days',
  pickSumTimes: 'You can do {dur}',
  pickSumNone: 'Nothing marked yet',
  discardQ: 'Discard your changes?',
  discard: 'Discard',

  weeks: 'Weeks',
  weekN: 'Week {n}',
  weekRange: 'Weeks {a}–{b}',
  weekPair: 'Weeks {a} and {b}',
  gridPaintLabel: 'Times. Arrow keys move, space marks.',
  gridViewLabel: 'Overview of the times',

  'err.network': 'Couldn’t reach the server. Check your connection and try again.',
  'err.rate': 'Too many requests. Wait a moment and try again.',
  'err.notFound': 'Event not found.',
  'err.forbidden': 'You’re not allowed to do that.',
  'err.closed': 'This event is closed for new answers.',
  'err.full': 'This event has as many answers as it can take.',
  'err.person': 'Answer not found. It may have been deleted.',
  'err.personName': 'Enter your name.',
  'err.email': 'That email address doesn’t look right.',
  'err.code': 'The code is wrong or has expired.',
  'err.wait.minute': 'You just asked for a code. Wait a minute before asking for a new one.',
  'err.wait.hour': 'You’ve asked for several codes. Try again in an hour.',
  'err.wait.day': 'Today’s limit for codes is reached. Try again tomorrow.',
  'err.mail': 'We can’t send email right now. Try again later.',
  'err.name': 'Give the event a name.',
  'err.range': 'Invalid dates.',
  'err.rangeLong': 'There can be at most a year from the first to the last day.',
  'err.rangeLongTimes': 'With times, there can be at most 62 days from the first to the last day.',
  'err.hours': 'Pick a valid time window.',
  'err.options': 'Pick at least one possible day or time.',
  'err.tooMany': 'Too many possible times (at most 2000). Pick fewer days or longer slots.',
  'err.server': 'Something went wrong. Try again.',

  'holiday.newYear': 'New Year’s Day',
  'holiday.maundyThursday': 'Maundy Thursday',
  'holiday.goodFriday': 'Good Friday',
  'holiday.easter': 'Easter Sunday',
  'holiday.easterMonday': 'Easter Monday',
  'holiday.mayDay': 'Labour Day',
  'holiday.constitutionDay': 'Constitution Day',
  'holiday.ascension': 'Ascension Day',
  'holiday.whitsun': 'Whit Sunday',
  'holiday.whitMonday': 'Whit Monday',
  'holiday.christmas': 'Christmas Day',
  'holiday.boxingDay': 'Boxing Day',
  'holiday.christmasEve': 'Christmas Eve',
  'holiday.newYearsEve': 'New Year’s Eve',
  'holiday.epiphany': 'Epiphany',
  'holiday.nationalDaySe': 'National Day of Sweden',
  'holiday.midsummerEve': 'Midsummer Eve',
  'holiday.midsummerDay': 'Midsummer Day',
  'holiday.allSaints': 'All Saints’ Day',
  'holiday.greatPrayerDay': 'Great Prayer Day',
  holidayCal: 'Public holidays in the calendar',
  holidayCalHint: 'Holidays get a dot, and the “Holidays” button picks them. Christmas Eve and New Year’s Eve are included, in Sweden Midsummer Eve too.',
  'holidayCal.no': 'Norway',
  'holidayCal.se': 'Sweden',
  'holidayCal.dk': 'Denmark',
  'holidayCal.none': 'None',
};

export const STRINGS: Record<Lang, Record<Key, Text>> = { nb, nn, sv, da, is, en };
// The language menu, in the order of each language's own name.
export const LANGS: readonly Lang[] = ['da', 'en', 'is', 'nb', 'nn', 'sv'];
export const LANG_NAMES: Record<Lang, string> = { da: 'Dansk', en: 'English', is: 'Íslenska', nb: 'Norsk bokmål', nn: 'Norsk nynorsk', sv: 'Svenska' };
const LOCALES: Record<Lang, string> = { nb: 'nb-NO', nn: 'nn-NO', sv: 'sv-SE', da: 'da-DK', is: 'is-IS', en: 'en-GB' };
// The calendars' column heads.
const WEEKDAYS: Record<Lang, string[]> = {
  nb: ['ma', 'ti', 'on', 'to', 'fr', 'lø', 'sø'],
  nn: ['må', 'ty', 'on', 'to', 'fr', 'la', 'sø'],
  sv: ['må', 'ti', 'on', 'to', 'fr', 'lö', 'sö'],
  da: ['ma', 'ti', 'on', 'to', 'fr', 'lø', 'sø'],
  is: ['má', 'þr', 'mi', 'fi', 'fö', 'la', 'su'],
  en: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
};
// When n takes the singular. Icelandic also uses it for 21, 31, ... (not
// 11); Intl.PluralRules can't say so, as Chromium has no Icelandic data.
const one = (n: number) => n === 1;
const PLURAL_ONE: Record<Lang, (n: number) => boolean> = { nb: one, nn: one, sv: one, da: one, en: one, is: (n) => n % 10 === 1 && n % 100 !== 11 };
const AND: Record<Lang, string> = { nb: 'og', nn: 'og', sv: 'och', da: 'og', is: 'og', en: 'and' };
// Hours and minutes in durations ("1 t 30 min").
const UNITS: Record<Lang, [h: string, min: string]> = { nb: ['t', 'min'], nn: ['t', 'min'], sv: ['tim', 'min'], da: ['t', 'min'], is: ['klst.', 'mín.'], en: ['h', 'min'] };

export const isLang = (l: unknown): l is Lang => (LANGS as readonly unknown[]).includes(l);

let lang: Lang = 'nb';
export const getLang = (): Lang => lang;
export function setLang(l: unknown): void {
  lang = isLang(l) ? l : 'en';
}

export type Vars = Record<string, string | number>;

export function t(key: Key, vars: Vars = {}): string {
  let s: Text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (typeof s === 'object') s = PLURAL_ONE[lang](Number(vars.n)) ? s.one : s.other;
  return s.replace(/\{(\w+)\}/g, (m: string, k: string) => (vars[k] !== undefined ? String(vars[k]) : m));
}

// For keys built at run time (error codes from the server and the like):
// unknown ones come back as the key itself.
export const tx = (key: string, vars?: Vars): string => t(key as Key, vars);

// "A og B", "A, B og C".
const joinAnd = (items: string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${AND[lang]} ${items[items.length - 1]}`);

// The names of the holidays on one date: "Grunnlovsdagen og 2. pinsedag".
export const holidayNames = (keys: readonly string[]): string => joinAnd(keys.map((k) => tx(`holiday.${k}`)));

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Chromium has no Intl data for nynorsk or Icelandic (it formats them as
// bokmål or English), so those two use their own names, in the style of
// bokmål's Intl output: "måndag 2. november", "2.–9. november 2026".
interface DateNames {
  months: string[];
  monthsShort: string[];
  days: string[]; // Monday first
  daysShort: string[];
  daySep: string; // between the weekday and the day
  rangeSep: string; // between the ends of a range across months
}
const OWN_NAMES: Partial<Record<Lang, DateNames>> = {
  nn: {
    months: ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'],
    monthsShort: ['jan.', 'feb.', 'mars', 'apr.', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'],
    days: ['måndag', 'tysdag', 'onsdag', 'torsdag', 'fredag', 'laurdag', 'søndag'],
    daysShort: ['må.', 'ty.', 'on.', 'to.', 'fr.', 'la.', 'sø.'],
    daySep: ' ',
    rangeSep: '–',
  },
  is: {
    months: ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí', 'ágúst', 'september', 'október', 'nóvember', 'desember'],
    monthsShort: ['jan.', 'feb.', 'mar.', 'apr.', 'maí', 'jún.', 'júl.', 'ágú.', 'sep.', 'okt.', 'nóv.', 'des.'],
    days: ['mánudagur', 'þriðjudagur', 'miðvikudagur', 'fimmtudagur', 'föstudagur', 'laugardagur', 'sunnudagur'],
    daysShort: ['mán.', 'þri.', 'mið.', 'fim.', 'fös.', 'lau.', 'sun.'],
    daySep: ', ',
    rangeSep: '\u2009–\u2009', // thin spaces, as ICU has them
  },
};
const ymd = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return { y, m: m - 1, day };
};

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALES[lang], { timeZone: 'UTC', ...opts });

export type DateStyle = 'long' | 'medium' | 'full' | 'monthShort';
const STYLES: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  long: { weekday: 'long', day: 'numeric', month: 'long' },
  medium: { weekday: 'short', day: 'numeric', month: 'short' },
  full: { day: 'numeric', month: 'long', year: 'numeric' },
  monthShort: { month: 'short' },
};

export function fmtDate(d: string, style: DateStyle = 'long'): string {
  const own = OWN_NAMES[lang];
  if (!own) return fmt(STYLES[style] ?? STYLES.long).format(toTime(d));
  const { y, m, day } = ymd(d);
  if (style === 'full') return `${day}. ${own.months[m]} ${y}`;
  if (style === 'monthShort') return own.monthsShort[m];
  if (style === 'medium') return `${own.daysShort[weekday(d)]}${own.daySep}${day}. ${own.monthsShort[m]}`;
  return `${own.days[weekday(d)]}${own.daySep}${day}. ${own.months[m]}`;
}

export function fmtRange(start: string, end: string): string {
  const own = OWN_NAMES[lang];
  if (own) {
    const a = ymd(start);
    const b = ymd(end);
    if (start === end) return fmtDate(start, 'full');
    if (a.y === b.y && a.m === b.m) return `${a.day}.–${b.day}. ${own.months[a.m]} ${a.y}`;
    if (a.y === b.y) return `${a.day}. ${own.months[a.m]}${own.rangeSep}${b.day}. ${own.months[b.m]} ${a.y}`;
    return `${fmtDate(start, 'full')}${own.rangeSep}${fmtDate(end, 'full')}`;
  }
  const f = fmt(STYLES.full);
  if (start === end) return f.format(toTime(start));
  try {
    return f.formatRange(toTime(start), toTime(end));
  } catch {
    return `${f.format(toTime(start))} – ${f.format(toTime(end))}`;
  }
}

// "november" (nb) / "November" (en).
export function monthName(d: string): string {
  const own = OWN_NAMES[lang];
  return own ? own.months[ymd(d).m] : fmt({ month: 'long' }).format(toTime(d));
}

export function monthTitle(y: number, m: number): string {
  const own = OWN_NAMES[lang];
  return cap(own ? `${own.months[m]} ${y}` : fmt({ month: 'long', year: 'numeric' }).format(Date.UTC(y, m, 1)));
}

export const weekdayShort = (): string[] => WEEKDAYS[lang];

export function weekdayLong(): string[] {
  const own = OWN_NAMES[lang];
  if (own) return [...own.days];
  const f = fmt({ weekday: 'long' });
  // 2024-01-01 was a Monday.
  return Array.from({ length: 7 }, (_, i) => f.format(Date.UTC(2024, 0, 1 + i)));
}

// "2.11." or "2/11".
export function shortDate(d: string): string {
  const { m, day } = ymd(d);
  return lang === 'en' || lang === 'sv' ? `${day}/${m + 1}` : `${day}.${m + 1}.`;
}

export function durationLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const [hu, mu] = UNITS[lang];
  if (!h) return `${m} ${mu}`;
  return m ? `${h} ${hu} ${m} ${mu}` : `${h} ${hu}`;
}

export function slotLabel(key: string, slot: number): string {
  const p = parseKey(key);
  if (!p || p.min === null) return key;
  return `${fmtDate(p.date, 'long')}, ${hhmm(p.min)}–${hhmm(p.min + slot)}`;
}

export function windowLabel(w: Pick<TimeWindow, 'date' | 'start' | 'end'>): string {
  return `${fmtDate(w.date, 'long')}, ${hhmm(w.start)}–${hhmm(w.end)}`;
}

