/**
 * Folded Swedish place names. They are generic in a company name ("<ort>"),
 * so they must not outrank the distinctive tokens.
 */
const PLACE_NAMES = `
stockholm goteborg malmo uppsala ostersund linkoping orebro vasteras helsingborg
norrkoping jonkoping umea lund boras sundsvall gavle halmstad vaxjo eskilstuna
karlstad sodertalje kristianstad kalmar falun skelleftea karlskrona lulea
huddinge nacka solna sundbyberg sollentuna haninge botkyrka jarfalla sigtuna
enkoping nykoping norrtalje visby karlskoga kristinehamn mariestad lidkoping
skovde trollhattan vanersborg uddevalla stenungsund kungalv molndal kungsbacka
varberg falkenberg angelholm hassleholm ystad trelleborg landskrona hoganas
almhult ljungby vastervik oskarshamn nassjo varnamo motala mjolby finspang
katrineholm strangnas koping arboga sala heby tierp gavle sandviken bollnas
hudiksvall ljusdal sundsvall timra harnosand kramfors solleftea ornskoldsvik
umea skelleftea lycksele pitea alvsbyn lulea boden kalix haparanda kiruna
gallivare jokkmokk osthammar knivsta habo mullsjo gislaved vaggeryd aneby
odeshog atvidaberg valdemarsvik soderkoping norrkoping katrineholm eskilstuna
vasteras koping are stromsund ostersund krokom berg sundsvall umea skelleftea
malmo lund helsingborg kristianstad karlskrona kalmar vaxjo jonkoping nassjo
varnamo linkoping norrkoping orebro karlstad eskilstuna vasteras uppsala
gavle falun borlange ludvika avesta sala enkopping nykoping norrkoping
sodertalje nacka huddinge haninge botkyrka huddinge taby vallentuna osteraker
varmdo nynashamn borlange avesta ludvika mora orsa alvdalen ratvik leksand
gagnef sater hedemora norberg fagersta skinnskatteberg hallstahammar surahammar
kungsor arboga koping vasteras sala heby tierp alvkarleby osthammar
`.split(/\s+/u);

export const PLACE_TOKENS: ReadonlySet<string> = new Set(PLACE_NAMES.filter((token) => token.length > 1));
