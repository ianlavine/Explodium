// Landmark Mania — a "Traffic Time" game on the Truck Mania city core: the same
// generated streets, stop signs, clock and time stones, and a die banked for
// every red light crossed. No packages, though. The board starts empty and the
// buildings are locations of four types — time stones, tokens, destress,
// landmarks — each with two open circles. Visiting one lets the player place a
// token of their color on a free circle (once per player per location) and
// take the reward. Ride cards point at landmark locations; driving there
// completes them, like Truck Mania's tickets. In the default ride-2 mode each
// player starts with two cards and a completed card is replaced on the spot;
// in ride-pickup mode using any landmark deals a fresh card instead. Every
// location belongs to one of ~10 neighbourhoods, drawn as light tinted zones.
//
// LANDMARK MODE (the `landmarkMode` setting) is the other game on this board,
// and turning it on derives every setting it owns. Fifty locations: 28 take
// tokens (6 time stone, 7 token, 11 discovery, 4 upgrade) and 22 are landmark
// destinations. No neighbourhoods and no destress locations — instead seven
// COLORS are scattered four locations apiece over the token-takers, and
// claiming three of a color's four scores 2 for the first player there and 1
// for the second. Landmark cards aren't dealt at setup: they're picked up at
// discovery locations, held two face up with the rest waiting face down, and
// each one driven is a point. The four upgrade locations each hold a face-up
// stack behind a named window (Morning / Afternoon / Evening / Night) with one
// circle per player, so everybody gets exactly one upgrade from each. Stress
// comes down by sleeping at night, napping by day, or the fun die.
//
// SIMPLE MODE (the `simpleMode` setting) is the third: fifty locations split
// evenly into FIVE neighbourhoods of ten — 1 time stone, 1 token, 2 discovery
// and 6 landmark destinations apiece — every token location a SINGLE circle,
// and 6 of the 20 open only by day and 6 only at night (spread a hood at a
// time, so none is ever shut), which is what keeps the clock turning. No
// upgrades, no destress.
// Landmark cards come off a discovery location one at a time with no choice
// about it, land face down on your own pile and flip at turn's end as far as
// the two-card window allows; anything still buried when the day ends expires.
//
// Everything scores through the STAR RATING, 0 to 5, starting at one full
// star. Each day's end pays up to two stars: a full one for a token in all
// five neighbourhoods (half for four of them), and a full one for an entirely
// empty hand (half for nothing left face down). A fine you can't cover costs
// half a star. Final score is completed landmarks × stars — so neither half is
// worth anything without the other — plus a ±3 swing on fines paid.
//
// FORCED MODE (the `forcedMode` setting) is the fourth, and the simplest to
// read: fifty locations in SEVEN neighbourhoods (six of seven, one of eight)
// that mean nothing at all — they exist so the eye can find its way around.
// Every location wears a name up top and an emoji in the middle, and carries
// exactly one circle. Thirty of them are REQUIRED: the circle is painted a
// single player's color and only that player may ever stand a token there,
// six per player. Four of each player's six are timed — two open only by day
// (☀️) and two only at night (🌙) — and the last two open whenever. They pay
// NOTHING. Every one you haven't covered when the game ends costs you a point,
// which is the whole reason to drive anywhere.
//
// The other twenty are SHARED: the circle is split diagonally between two
// player colors, and there are exactly two locations for each of the ten pairs
// five players make — one paying tokens, one paying time stones. Only the two
// named players may use it, and only one of them ever will: whoever gets there
// first takes the full reward (4 tokens / 6 stones) and the other name on the
// circle is handed HALF (2 / 3) on the spot, wherever they are. Going shopping
// always tips somebody off.
//
// Landmark cards run on the duplicate-mode plumbing — every location is a
// possible destination — and the hand is always two, topped back up at the end
// of each turn. Each one completed is a point. Because a card can point at a
// location you could also stand a token on, arriving is a choice of one or the
// other, never both: you have to actually move to do the second.
//
// Tokens NEVER come off the board here — no dawn sweep, and nothing happens at
// the end of a day at all; the three days are just the clock running out. A
// fine you have no tokens to pay counts DOUBLE on your fine tally instead of
// costing tokens you don't have. Scoring: +1 per landmark card completed, −1
// per uncovered required location, and ±1 for the fewest / most fines paid,
// with fines breaking ties.
//
// The stress bar sits beside the clock: 1–6, each player's marker in a gap
// between two numbers (start: between 2 and 3, i.e. stress 2). At turn end the
// banked dice roll — a die at or under the marker is fine, over it costs a
// token. Destress locations move the marker one gap down the bar (stress +1,
// more safe numbers).
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCityMap, randomizeOctagons, deriveSpots, setBlankLights } from "../traffic-time/map.js";
import { buildStreetGraph, findPath, findRouteDirected } from "../traffic-time/routing.js";

// Named tuning versions persist here (same pattern as Truck Mania's saved
// settings). Set LANDMARK_MANIA_SAVES=off (e.g. on a hosted deploy) to make the
// list read-only.
const SETTINGS_FILE = fileURLToPath(new URL("./saved-settings.json", import.meta.url));
const savingEnabled = process.env.LANDMARK_MANIA_SAVES !== "off";

function loadSavedSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSavedSettings(list) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(list, null, 2));
  } catch (err) {
    console.error("landmark-mania: failed to persist settings:", err.message);
  }
}

// The game opens at 7am — the first hour of the day — and a "day" runs 7am to
// 7am: the day counter ticks whenever the clock crosses 6am into 7am, not at
// midnight. (elapsed hours track it: day boundaries land exactly on multiples
// of 24 because the game starts at 7.)
const START_TIME = 7;
const faceHour = (t) => ((t + 11) % 12) + 1;
// Night runs 7pm–6am (the Day, Night scheme's hours) — it drives the clock's
// moon icon and when sleeping is allowed.
const isNight = (t) => t >= 19 || t <= 6;

// Timed locations (the timedPeriods setting, default off). Two schemes:
// 3 — Morning, Afternoon, Night: every circle location belongs to one period
//     (morning 6am–noon, afternoon 1pm–8pm, night 9pm–5am) and only opens
//     while the clock sits inside it.
// 2 — Day, Night: the settings' dayLocations count opens only in the day
//     (7am–6pm) and nightLocations only at night (7pm–6am); every leftover
//     circle location is unrestricted (no period).
// (Keep these in sync with the client.)
const PERIODS = ["morning", "afternoon", "night"];
const periodOf = (t) => (t >= 6 && t <= 12 ? "morning" : t >= 13 && t <= 20 ? "afternoon" : "night");
const dayNightOf = (t) => (t >= 7 && t <= 18 ? "day" : "night");
// Is this location open right now under the settings' timed scheme?
const locOpen = (settings, b, t) =>
  !b.period || ((settings.timedPeriods ?? 0) === 2 ? dayNightOf(t) : periodOf(t)) === b.period;

// Scheduled upgrade mode slices the day into six 4-hour windows — 1–4am,
// 5–8am, 9am–12pm, 1–4pm, 5–8pm, 9pm–12am — and each upgrade location only
// opens during its own. (Keep windowOf in sync with the client.)
const UPGRADE_WINDOW_COUNT = 6;
const windowOf = (t) => Math.floor(((t + 23) % 24) / 4);

// Landmark mode's four named upgrade windows — one per upgrade location, each
// only usable inside its own hours. They tile the whole clock in six-hour
// blocks starting at 7am, so Evening wraps midnight. (Keep in sync with the
// client.)
const LANDMARK_WINDOWS = [
  { id: "morning", name: "Morning", label: "7am–noon", from: 7, to: 12 },
  { id: "afternoon", name: "Afternoon", label: "1–6pm", from: 13, to: 18 },
  { id: "evening", name: "Evening", label: "7pm–midnight", from: 19, to: 0 },
  { id: "dawn", name: "Dawn", label: "1–6am", from: 1, to: 6 }
];
const landmarkWindowOpen = (i, t) => {
  const w = LANDMARK_WINDOWS[i];
  if (!w) return true;
  // Evening runs 19:00 through midnight, so its range wraps past 23.
  return w.from <= w.to ? t >= w.from && t <= w.to : t >= w.from || t <= w.to;
};

// The seats' colors — and the size of the table. Forced mode's board is dealt
// for all five whether or not five are playing (a missing seat's circles just
// sit there), so this list is what "five players" means everywhere.
const PLAYER_COLORS = ["#3ac0c0", "#e0559c", "#e0a13a", "#7b6fe0", "#57b947"];

// The location types.
// - Classic: upgrade locations take no tokens — they sit dead until the one
//   roaming upgrade lands on them, and picking it up is the visit.
// - Landmark mode: "discovery" locations deal a landmark card, upgrade
//   locations take a token like any other (one circle per player), and
//   "landmark" locations are the card destinations. (The landmark type was
//   called "uber" before landmark mode — saved tunings are migrated.)
// - Star mode: no upgrade locations at all — "star" locations raise the
//   driver's rating instead, and every token location has a single circle.
// - Forced mode: "required" locations, which pay nothing at all — their
//   single circle belongs to one named player, and leaving it uncovered at
//   the end costs a point. Its time-stone and token locations are SHARED:
//   the circle belongs to two named players, and using one pays the other
//   half of the reward wherever they are.
const LOC_TYPES = ["timestone", "token", "destress", "upgrade", "discovery", "star", "landmark", "required"];
// The types that take a player's token onto a circle.
const CIRCLE_TYPES = ["timestone", "token", "destress", "discovery", "star", "required"];

// Neighbourhood colors: each location is painted its neighbourhood's color
// (the client outlines it in a darker shade of the same). Names are internal
// only — the board reads by color. Colors are dealt IN THIS ORDER, so a game
// only reaches into the light shades when it has that many neighbourhoods —
// and when light blue / light green join, the plain blue / green go dark so
// the pairs stay tellable-apart.
const HOOD_NAMES = [
  "Old Town", "Docks", "Midtown", "Sunset", "Riverside",
  "Uptown", "Market", "Garden", "Harbor", "Heights", "Foundry"
];
const HOOD_BASE_COLORS = [
  "#d94040", // red
  "#4f7fd9", // blue
  "#e8c832", // yellow
  "#9c5fd0", // purple
  "#e8853a", // orange
  "#55b055", // green
  "#ef86c0", // pink
  "#a9764f", // brown
  "#9aa2ac", // grey
  "#7fc4e8", // light blue
  "#96d989"  // light green
];

function hoodPalette(k) {
  const out = HOOD_BASE_COLORS.slice(0, Math.max(1, Math.min(k, HOOD_BASE_COLORS.length)));
  if (out.length >= 10) out[1] = "#2b4d99"; // light blue in play — the blue goes dark
  if (out.length >= 11) out[5] = "#2e7d32"; // light green in play — the green goes dark
  return out;
}

// Landmark mode has no neighbourhoods — it has seven COLORS, each spread over
// four token-requiring locations anywhere on the map. The first player to
// claim three of a color's four scores, and so does the second. The palette is
// the first seven hood colors (they read apart at a glance); the names are
// only for tooltips and the scoring chart.
const LANDMARK_COLOR_COUNT = 7;
const LANDMARK_COLOR_SIZE = 4; // token locations per color
const COLOR_NAMES = ["Red", "Blue", "Yellow", "Purple", "Orange", "Green", "Pink"];
// Landmark locations belong to no color — they wear this neutral stone.
const NO_COLOR = "#cfc9bd";

// Names for the token-circle locations (time stones / tokens / destress) —
// plain everyday places, the kind you'd actually run errands at.
const LOC_NAMES = [
  "Mall", "Dentist", "Gym", "Library", "School", "Bank",
  "Pharmacy", "Grocery Store", "Post Office", "Hair Salon", "Coffee Shop",
  "Bakery", "Pizza Place", "Cinema", "Hospital", "Vet", "Barber",
  "Bookstore", "Hardware Store", "Laundromat", "Diner", "Hotel",
  "Museum", "Arcade", "Pet Shop", "Florist", "Butcher", "Toy Store",
  "Shoe Store", "Optician", "Tailor", "Car Wash", "Gas Station",
  "Ice Cream Shop", "Doctor", "Playground", "Police Station",
  "Fire Station", "Supermarket", "Music Store", "Nail Salon", "Daycare",
  "Furniture Store", "Bus Station", "City Hall"
];

// Landmark locations are famous places: a big emoji on the board, and the
// landmark card carries the name up top with the emoji in the middle.
// Plain names that just say what the picture is — the board shows the name
// above the emoji, so "Pool 🏊" reads instantly and nothing has to be
// decoded. (Star mode seats 27 of these, so keep the list comfortably longer
// than that; the names steer clear of LOC_NAMES to avoid two "Library"s.)
const LANDMARK_PLACES = [
  { name: "Ferris Wheel", emoji: "🎡" }, { name: "Roller Coaster", emoji: "🎢" },
  { name: "Circus", emoji: "🎪" }, { name: "Bowling Alley", emoji: "🎳" },
  { name: "Theatre", emoji: "🎭" }, { name: "Art Gallery", emoji: "🎨" },
  { name: "Castle", emoji: "🏰" }, { name: "Statue", emoji: "🗽" },
  { name: "Fountain", emoji: "⛲" }, { name: "Zoo", emoji: "🦁" },
  { name: "Aquarium", emoji: "🐠" }, { name: "Stadium", emoji: "⚽" },
  { name: "Basketball Court", emoji: "🏀" }, { name: "Tennis Court", emoji: "🎾" },
  { name: "Pool", emoji: "🏊" }, { name: "Golf Course", emoji: "⛳" },
  { name: "Fishing Pier", emoji: "🎣" }, { name: "Park", emoji: "🌳" },
  { name: "Volcano", emoji: "🌋" }, { name: "Train Station", emoji: "🚂" },
  { name: "Campground", emoji: "⛺" }, { name: "Tower", emoji: "🗼" },
  { name: "Beach", emoji: "🏖️" }, { name: "Mountain", emoji: "🏔️" },
  { name: "Carousel", emoji: "🎠" }, { name: "Church", emoji: "⛪" },
  { name: "Bridge", emoji: "🌉" }, { name: "Ski Hill", emoji: "🎿" },
  { name: "Ice Rink", emoji: "⛸️" }, { name: "Race Track", emoji: "🏎️" },
  { name: "Airport", emoji: "✈️" }, { name: "Harbour", emoji: "⚓" },
  { name: "Farm", emoji: "🚜" }, { name: "Windmill", emoji: "🌬️" }
];

// Duplicate mode: every location wears its own emoji (separate from the
// payout symbol in its circle) so ride cards can point at it by picture.
const LOC_EMOJIS = [
  "🍩", "🎂", "🌮", "🍜", "🍕", "☕", "🍦", "🥐", "🥨", "🍭", "🫖", "🍇",
  "🥑", "🎈", "🎁", "📚", "🎩", "👟", "💈", "🔧", "🧴", "🌵", "🐟", "🧸",
  "🎻", "🥁", "🖼️", "🕹️", "📀", "📷", "⌚", "💍", "🔑", "🧲", "🚲", "🛹",
  "🛶", "⚓", "🪁", "🧵", "🪴", "🕰️", "🎀", "🦜", "🍯", "🧀", "🥾", "🪞"
];

// The upgrade types the roaming upgrade can spawn as. A player keeps every
// upgrade they pick up (player.upgrades is a list of these ids). The supply
// is a depleting deck: TWO copies of each type here, plus one neighbourhood
// upgrade per hood — once the deck runs dry no new upgrade spawns.
const UPGRADE_TYPES = [
  "uturn",         // routes may U-turn (client routing honors it too)
  "rightOnRed",    // right turns at red lights don't bank a die (client-side count)
  "nearbyParking", // use any location in the block you parked at
  "timeLord",      // change the time any number of times per turn
  "superCalm",     // sleeping drops the marker to between 5 and 6 (only 6 fails)
  "extraCash",     // +1 token whenever tokens are collected
  "extraTime",     // +2 stones whenever time stones are collected
  "extraRide",     // hand grows by one ride card (dealt on pickup)
  "timeAgnostic",  // timed locations open at any hour
  "undercut"       // full locations still take your token — it slips beneath
];
const hasUp = (player, type) => Array.isArray(player?.upgrades) && player.upgrades.includes(type);

// Neighbourhood upgrades: every hood owns exactly one, id "hood:<id>". Ending
// a turn parked at a location of that hood pays a reward of the holder's
// choosing — 1 token, 1 destress step, or 2 time stones — before the stress
// dice roll.
const HOOD_REWARDS = ["token", "destress", "stones"];
const parseHoodUpgrade = (type) => {
  const m = /^hood:(\d+)$/.exec(type ?? "");
  return m ? { hood: Number(m[1]) } : null;
};
// A client-sent reward-choice list, scrubbed down to known rewards.
const cleanHoodChoices = (raw) =>
  Array.isArray(raw) ? raw.filter((c) => HOOD_REWARDS.includes(c)).slice(0, 12) : [];

// Stress: `player.stress = n` means the marker sits between n and n+1 on the
// 1–6 bar; a die roll of n or under is safe. A destress location moves the
// marker ONE gap down the bar; sleeping (at night, in place of the turn)
// drops it all the way to between 4 and 5 — between 5 and 6 with super calm.
const STRESS_MIN = 1;
const STRESS_MAX = 5;
const DESTRESS_TO = 4; // where the classic game's sleep lands (superCalm: 5)
// Landmark mode rests deeper: sleeping, napping and the fun die all cap at
// the bottom of the bar (5 — only a 6 fines you), and super calm pushes one
// step PAST it, where no die can fine you at all.
const STRESS_IMMUNE = 6;
const restCap = (player) => (hasUp(player, "superCalm") ? STRESS_IMMUNE : STRESS_MAX);
// Landmark and Star modes have no destress locations. Stress comes down three
// ways: sleeping at night (the full reset above), NAPPING during the day — the
// same whole-turn cost for two steps down the bar — and the fun die.
const NAP_STEPS = 2;

// ---- Star mode ------------------------------------------------------------
// The driver's RATING, on a second bar beside the stress meter: whole and half
// stars from 0 to 10. It starts at 2, a star location adds one, and every
// landmark card still in hand when a day ends is "late" and costs half a star.
// Completing a card pays its holder the rating rounded DOWN, on the spot.
const RATING_MAX = 7;
const RATING_START = 2;
const STAR_STEP = 1;      // a star location's boost
const LATE_STEP = 0.5;    // rating lost per card left undelivered at day's end
// Points paid at the end of each day for the number of DIFFERENT
// neighbourhoods the player has a token standing in (index = that count) —
// so two neighbourhoods pay nothing and only a real spread is worth chasing.
const HOOD_SPREAD_SCORE = [0, 0, 0, 1, 3, 6];
// Star mode shows two landmark cards at a time; the rest wait face down.
const STAR_VISIBLE_CARDS = 2;
const STAR_HOOD_COUNT = 5;

// ---- Simple mode ----------------------------------------------------------
// Five neighbourhoods of ten locations each, dealt identically: four take a
// token (one time stone, one token, two discovery) and six are landmark
// destinations. Fifty locations, thirty landmark cards.
const SIMPLE_HOOD_COUNT = 5;
const SIMPLE_HOOD_CIRCLES = ["timestone", "token", "discovery", "discovery"];
const SIMPLE_HOOD_LANDMARKS = 6;
const SIMPLE_HOOD_SIZE = SIMPLE_HOOD_CIRCLES.length + SIMPLE_HOOD_LANDMARKS;
const SIMPLE_TOTAL = SIMPLE_HOOD_COUNT * SIMPLE_HOOD_SIZE;
// Cards a player holds face up; the rest wait in their own face-down pile and
// expire if the day ends before they flip.
const SIMPLE_VISIBLE_CARDS = 2;
// The star rating: five stars, opening on one whole one. Each day's end can
// pay up to two — a full star for a token in every neighbourhood (half for one
// short) and a full star for an empty hand (half for nothing face down) — and
// a fine there were no tokens left to cover costs half.
// Of the 20 token locations: this many open only by day, this many only at
// night, and the remaining eight open whenever. Six doesn't divide over five
// neighbourhoods, so the sixth of each lands in a different hood from the
// other's — no neighbourhood ends up gated shut at any hour.
const SIMPLE_DAY_LOCATIONS = 6;
const SIMPLE_NIGHT_LOCATIONS = 6;
const SIMPLE_STAR_MAX = 5;
const SIMPLE_START_STARS = 1;
const SIMPLE_STAR_STEP = 1;
const SIMPLE_HALF_STEP = 0.5;
const SIMPLE_SHORT_STARS = 0.5;

// ---- Forced mode ----------------------------------------------------------
// Fifty locations in seven neighbourhoods that carry no rules whatsoever —
// six of seven locations and one of eight, purely so the board has landmarks
// for the eye. Every location has ONE circle.
const FORCED_HOOD_COUNT = 7;
const FORCED_TOTAL = 50;
// Thirty required locations — six per seat, single-colored — and twenty
// shared ones: ten pairs of seats, two locations each (one tokens, one
// stones).
const FORCED_REQUIRED_PER_SEAT = 6;
const FORCED_PAIR_LOCATIONS = 2; // per unordered pair of seats: 1 token, 1 stones
// Of a seat's six required locations: this many open only by day, this many
// only at night, and the rest open whenever. Shared locations are never timed
// — they're the only thing on the board you can always reach.
const FORCED_DAY_PER_SEAT = 2;
const FORCED_NIGHT_PER_SEAT = 2;
// What a shared location pays the player who gets there. The other name on
// the circle collects half, rounded down, on the spot.
const FORCED_TOKEN_REWARD = 4;
const FORCED_STONE_REWARD = 6;
// The hand is always this many landmark cards, face up, topped back up at the
// end of every turn. Nothing is ever face down, so nothing ever expires.
const FORCED_CARDS = 2;
// A fine with no tokens left to pay it costs no tokens — it counts this many
// times over on the fine tally instead, which is what the end-game swing and
// the tiebreak both read.
const FORCED_SHORT_FINES = 2;
// The neighbourhood palette forced mode uses INSTEAD of the standard one: the
// hoods here are wallpaper, and the five vivid player colors are the thing
// that has to read at a glance. So the hoods go muted — mid-saturation, sat
// well away from PLAYER_COLORS in both brightness and chroma — and only ever
// show up as a building's tint and border, never inside a circle.
const FORCED_HOOD_COLORS = [
  "#a9714b", // clay
  "#5f7fa3", // slate
  "#6f9152", // moss
  "#a2617f", // plum
  "#7b6f9e", // heather
  "#3f8f86", // pine
  "#9b8b45"  // ochre
];
// Forced mode's locations are named for their picture: the board shows the
// name across the top and the emoji big underneath, and the landmark cards
// point at them by both. Plain errand-running places — keep this list
// comfortably longer than the fifty a board seats.
const FORCED_PLACES = [
  { name: "Mall", emoji: "🏬" }, { name: "Dentist", emoji: "🦷" },
  { name: "Gym", emoji: "🏋️" }, { name: "Library", emoji: "📚" },
  { name: "School", emoji: "🏫" }, { name: "Bank", emoji: "🏦" },
  { name: "Pharmacy", emoji: "💊" }, { name: "Grocer", emoji: "🛒" },
  { name: "Post Office", emoji: "📮" }, { name: "Hair Salon", emoji: "💇" },
  { name: "Coffee Shop", emoji: "☕" }, { name: "Bakery", emoji: "🥐" },
  { name: "Pizza Place", emoji: "🍕" }, { name: "Cinema", emoji: "🎬" },
  { name: "Hospital", emoji: "🏥" }, { name: "Vet", emoji: "🐕" },
  { name: "Barber", emoji: "💈" }, { name: "Bookstore", emoji: "📖" },
  { name: "Hardware", emoji: "🔧" }, { name: "Laundromat", emoji: "🧺" },
  { name: "Diner", emoji: "🍳" }, { name: "Hotel", emoji: "🛎️" },
  { name: "Museum", emoji: "🏛️" }, { name: "Arcade", emoji: "🕹️" },
  { name: "Pet Shop", emoji: "🐹" }, { name: "Florist", emoji: "💐" },
  { name: "Butcher", emoji: "🥩" }, { name: "Toy Store", emoji: "🧸" },
  { name: "Shoe Store", emoji: "👟" }, { name: "Optician", emoji: "👓" },
  { name: "Tailor", emoji: "🧵" }, { name: "Car Wash", emoji: "🚿" },
  { name: "Gas Station", emoji: "⛽" }, { name: "Ice Cream", emoji: "🍦" },
  { name: "Doctor", emoji: "🩺" }, { name: "Playground", emoji: "🎠" },
  { name: "Police Station", emoji: "🚓" }, { name: "Fire Station", emoji: "🚒" },
  { name: "Supermarket", emoji: "🥦" }, { name: "Music Store", emoji: "🎸" },
  { name: "Nail Salon", emoji: "💅" }, { name: "Daycare", emoji: "🍼" },
  { name: "Furniture", emoji: "🛋️" }, { name: "Bus Station", emoji: "🚌" },
  { name: "City Hall", emoji: "🏢" }, { name: "Deli", emoji: "🥪" },
  { name: "Juice Bar", emoji: "🥤" }, { name: "Theatre", emoji: "🎭" },
  { name: "Park", emoji: "🌳" }, { name: "Pool", emoji: "🏊" },
  { name: "Bowling Alley", emoji: "🎳" }, { name: "Train Station", emoji: "🚉" },
  { name: "Farmers Market", emoji: "🥕" }, { name: "Aquarium", emoji: "🐠" },
  { name: "Bike Shop", emoji: "🚲" }, { name: "Golf Course", emoji: "⛳" }
];

// Ride modes: "ride-2" (default) starts every player with two ride cards and
// replaces each one as it completes — uber pickups are destinations only.
// "ride-pickup" is the original rule: visiting any uber pickup deals a card.
// "duplicate" builds on ride-2: no uber pickups at all — every location is a
// one-circle reward location AND a possible ride destination, and landing on
// one is a choice: visit it (the circle) or complete a matching card, never
// both.
const RIDE_MODES = ["ride-2", "ride-pickup", "duplicate"];

// Upgrade modes: "spawn" (default) keeps the one roaming upgrade — a random
// new one appears at another upgrade location when it's taken. "scheduled"
// deals an upgrade to EVERY upgrade location up front; each location gets a
// fixed 4-hour window and only opens during it, and nothing respawns.
// "stack" is landmark mode's: each of the four upgrade locations holds a
// face-up STACK — take the top one (paying a token onto your own circle) and
// the next one shows.
const UPGRADE_MODES = ["spawn", "scheduled", "stack"];

const BASE_SETTINGS = {
  // Landmark mode: the alternative game — 50 locations, seven scoring colors,
  // no neighbourhoods and no destress locations, landmark cards picked up at
  // discovery locations. Turning it on derives every setting below it that
  // the mode fixes (see landmarkOverrides).
  landmarkMode: false,
  // Star mode: the other alternative game — 52 locations, five neighbourhoods
  // scored fresh every day, a star rating that sets what each landmark card
  // pays, and a board that wipes its tokens each dawn. Exclusive with landmark
  // mode; turning it on derives everything below it that the mode fixes.
  starMode: false,
  // Simple mode: the third — 50 locations in five even neighbourhoods, two
  // landmark-card decks you choose between by color, no upgrades and no
  // stars. Exclusive with the other two, and derives everything it fixes.
  simpleMode: false,
  // Forced mode: the fourth — 50 locations in seven decorative
  // neighbourhoods, 30 of them belonging to one player each (and costing that
  // player a point if left uncovered) and 20 split between two. Exclusive
  // with the other three, and derives everything it fixes.
  forcedMode: false,
  rideMode: "ride-2",
  upgradeMode: "spawn",
  // How many locations of each type get seated (≈45 total).
  locations: {
    timestone: 11, token: 11, destress: 11, upgrade: 6,
    discovery: 0, star: 0, landmark: 12, required: 0
  },
  // Timed locations: 0 (none — no periods, no rules) or 3 (the three visiting
  // periods; circle locations only open during theirs).
  timedPeriods: 0,
  // The Day, Night scheme (timedPeriods 2): how many circle locations open
  // only in the day and only at night — the leftovers carry no period.
  dayLocations: 11,
  nightLocations: 11,
  timeStoneReward: 4, // stones a time-stone location pays
  tokenReward: 3,     // tokens a token location pays
  startingTokens: 10,
  startingTimeStones: 3,
  startingStress: 3,  // marker between 3 and 4
  tokensPerFail: 1,   // tokens paid per failed end-of-turn die
  neighbourhoods: 10,
  // The game ends after this many days on the clock (a day = 24h = two full
  // sweeps of the face), scored at the end of the turn that crosses the line.
  days: 3,
  // Scoring: points per completed ride, the race to fill all four upgrade
  // slots (7 for the first player, then 5, 3, 1), and the red-light swing —
  // the player(s) who lost the most tokens to red-light dice lose it, the
  // least gain it. (Neighbourhood visits score nothing — they unlock the
  // third and fourth upgrade slots instead.)
  ridePoints: 2,
  redPenalty: 3,
  // ---- Landmark-mode scoring (ignored in the classic game) ----------------
  // Colors: three of a color's four locations scores — 2 for the first player
  // there, 1 for the second (21 points across the seven colors).
  colorFirstPoints: 2,
  colorSecondPoints: 1,
  // Upgrades: one point each.
  upgradePoints: 1,
  // Landmark cards: one point per card completed, plus a bonus shared by
  // everyone tied for the most completed.
  landmarkPoints: 1,
  mostLandmarksBonus: 2,
  // Fines (tokens paid to failed dice): the player(s) who paid the FEWEST
  // gain this. Fines are also the tiebreak on equal totals — fewest wins.
  // (Paying the most costs nothing extra.)
  finePoints: 2,
  // The two ways landmark mode takes points off you, both counted as they
  // happen and revealed at the end:
  // — every landmark card still face down in your stack when a night ends
  //   (the clock crossing 6am into 7am) costs this,
  cardPenalty: 1,
  // — and every token you come up short when the dice ask you to pay.
  shortPenalty: 1,
  // ---- Star-mode scoring (ignored elsewhere) -----------------------------
  // Where the rating starts and where it tops out, in stars.
  startingRating: RATING_START,
  ratingMax: RATING_MAX,
  // Points at day's end for the number of different neighbourhoods you hold a
  // token in — index 0 is "none", index 5 is "all five".
  hoodSpread: [...HOOD_SPREAD_SCORE],
  // End-game bonuses, each SPLIT between everyone tied for it: most landmark
  // cards completed, and fewest fines paid.
  starMostBonus: 6,
  starFineBonus: 6,
  // ---- Simple-mode scoring (ignored elsewhere) ---------------------------
  // Where the star rating opens. (Its cap is the mode's own — five stars.)
  simpleStartStars: SIMPLE_START_STARS,
  // The end-game fine swing: the player(s) who paid the fewest gain this, the
  // player(s) who paid the most lose it. Everything else is landmarks × stars.
  simpleFineSwing: 3,
  // ---- Forced-mode scoring (ignored elsewhere) ---------------------------
  // Every landmark card completed is worth this, and every required location
  // of your color still standing empty at the end costs this.
  forcedCardPoints: 1,
  forcedMissPenalty: 1,
  // The end-game fine swing: the player(s) who paid the fewest gain this, the
  // player(s) who paid the most lose it. Fines break ties either way.
  forcedFineSwing: 1,
  // How many landmark cards a hand holds, topped back up at the end of every
  // turn. Nothing here is ever face down.
  forcedCards: FORCED_CARDS,
  // Welfare: skipping the turn (before doing anything) pays this. In landmark
  // mode welfare is the DAYTIME skip (tokens only, no stones) and begging is
  // its night counterpart.
  welfareTokens: 1,
  welfareStones: 2,
  begTokens: 1,
  // Time stones handed out for begging. Zero everywhere except forced mode,
  // where the clock is the only thing that ends the game and the board's only
  // other stone supply (four split circles per player) runs dry.
  begStones: 0,
  // Blank stoplights on top of the guaranteed 24 numbered ones. The map is
  // generated to carry exactly 24 + green + red lights; the four light-free
  // corners come on top of that.
  blankLights: { green: 6, red: 6 }
};

const cloneSettings = (s) => JSON.parse(JSON.stringify(s));

// Clamp a submitted number into range, falling back when it isn't a number at
// all — the tuning panel should always apply something sensible rather than
// silently rejecting a stray keystroke.
function intClamp(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Landmark mode fixes its own board and rewards — the user turns the mode on
// and everything it owns is derived, so those fields go read-only in the
// tuning panel. What's left tunable: the days, the starting stash, the stress
// numbers, welfare, the stoplight mix and every scoring number.
//
// 50 locations: 28 take tokens (7 colors × 4) and 22 are landmark
// destinations. The 28: 6 time stone, 7 token, 11 discovery, 4 upgrade.
const LANDMARK_LOCATIONS = {
  timestone: 6, token: 7, destress: 0, upgrade: 4, discovery: 11, star: 0, landmark: 22, required: 0
};
// Star mode: 52 locations — 25 take tokens (5 time stone, 6 token, 9 landmark
// pickup, 5 star; no upgrade locations at all) and 27 are landmark
// destinations. Every token location has a SINGLE circle, and the whole board
// wipes its tokens at the end of each day.
const STAR_LOCATIONS = {
  timestone: 5, token: 6, destress: 0, upgrade: 0, discovery: 9, star: 5, landmark: 27, required: 0
};
// Simple mode: 50 locations, five neighbourhoods' worth of the same ten — but
// the counts still go through the deal, so they're spelled out here too.
const SIMPLE_LOCATIONS = {
  timestone: SIMPLE_HOOD_COUNT, token: SIMPLE_HOOD_COUNT, destress: 0, upgrade: 0,
  discovery: SIMPLE_HOOD_COUNT * 2, star: 0,
  landmark: SIMPLE_HOOD_COUNT * SIMPLE_HOOD_LANDMARKS, required: 0
};
// Of the token locations, this many open only by day and this many only by
// night; the rest are open whenever. (You can always drive to a closed one —
// you just can't use it until its time.) Landmark mode: 7/7 of 24, leaving 10.
// Star mode: 8/8 of all 25, stars included, leaving 9.
// Forced mode: 50 locations — 30 "required" (six per seat, paying nothing at
// all) and 20 shared reward locations, ten of each kind, one per pair of
// seats. No landmark destinations: the cards run on duplicate-mode plumbing,
// where every location on the board is a possible one.
const FORCED_LOCATIONS = {
  timestone: (PLAYER_COLORS.length * (PLAYER_COLORS.length - 1)) / 2,
  token: (PLAYER_COLORS.length * (PLAYER_COLORS.length - 1)) / 2,
  destress: 0, upgrade: 0, discovery: 0, star: 0, landmark: 0,
  required: PLAYER_COLORS.length * FORCED_REQUIRED_PER_SEAT
};
const LANDMARK_DAY_LOCATIONS = 7;
const LANDMARK_NIGHT_LOCATIONS = 7;
const STAR_DAY_LOCATIONS = 8;
const STAR_NIGHT_LOCATIONS = 8;
// Forced mode times only the required locations — two of each seat's six by
// day and two at night, so ten and ten across the five seats.
const FORCED_DAY_LOCATIONS = PLAYER_COLORS.length * FORCED_DAY_PER_SEAT;
const FORCED_NIGHT_LOCATIONS = PLAYER_COLORS.length * FORCED_NIGHT_PER_SEAT;
// The fields landmark and star mode take over — greyed out in the tuning
// panel, and stashed under `classic` so switching back off puts the board the
// user had built back exactly as it was. EVERY key listed here must be read
// through `src` in sanitizeSettings (not `raw`), or leaving the mode hands
// back the override instead of the value it was covering.
const LANDMARK_OWNED = [
  "rideMode", "upgradeMode", "timedPeriods", "locations",
  "timeStoneReward", "tokenReward", "neighbourhoods",
  "dayLocations", "nightLocations", "startingTokens", "startingTimeStones",
  "welfareTokens", "welfareStones", "begStones"
];
// What both alternative modes share: the card plumbing, the day/night board,
// the reward numbers and the handouts.
function modeCommon(s, stashed) {
  return {
    ...s,
    classic: stashed ?? Object.fromEntries(LANDMARK_OWNED.map((k) => [k, s[k]])),
    rideMode: "ride-2",       // the cards run on the ride-2 plumbing
    // Day / Night locations: each mode sets its own counts below; the rest
    // of the token locations open whenever.
    timedPeriods: 2,
    timeStoneReward: 5,
    tokenReward: 3,
    // The first seat opens on this many tokens and each seat after it gets one
    // more, to pay off the turn-order advantage.
    startingTokens: 5,
    startingTimeStones: 6,
    // Daytime welfare is two tokens flat — no time stones in these modes.
    welfareTokens: 2,
    welfareStones: 0
  };
}

function landmarkOverrides(s, stashed) {
  return {
    ...modeCommon(s, stashed),
    starMode: false,
    upgradeMode: "stack",     // four locations, each a face-up stack
    dayLocations: LANDMARK_DAY_LOCATIONS,
    nightLocations: LANDMARK_NIGHT_LOCATIONS,
    locations: { ...LANDMARK_LOCATIONS },
    neighbourhoods: LANDMARK_COLOR_COUNT
  };
}

// Simple mode's board: five even neighbourhoods and no upgrade or star
// locations. It keeps the Day / Night board its siblings use — one day and one
// night location in EVERY neighbourhood, the other two open whenever — because
// that's what pushes the clock: a mode whose whole shape is "what you did
// today" needs the days to actually turn over, and nothing else makes a player
// spend time stones on the hour.
function simpleOverrides(s, stashed) {
  return {
    ...modeCommon(s, stashed),
    landmarkMode: false,
    starMode: false,
    // No upgrade locations exist, so the roaming upgrade never spawns.
    upgradeMode: "spawn",
    dayLocations: SIMPLE_DAY_LOCATIONS,
    nightLocations: SIMPLE_NIGHT_LOCATIONS,
    locations: { ...SIMPLE_LOCATIONS },
    neighbourhoods: SIMPLE_HOOD_COUNT,
    // The meter is five stars here, not star mode's seven — the client's
    // rating bar reads this, so the mode owns it.
    ratingMax: SIMPLE_STAR_MAX
  };
}

// Forced mode's board. It is the only mode that runs the cards on DUPLICATE
// plumbing — there are no landmark destinations, so every one of the fifty
// locations is a possible card, and arriving somewhere you could also stand a
// token is a choice between the two rather than both. The rewards are the
// richest of any mode (4 tokens / 6 stones) because only twenty locations pay
// anything at all, and each of those is shared between two seats.
function forcedOverrides(s, stashed) {
  return {
    ...modeCommon(s, stashed),
    landmarkMode: false,
    starMode: false,
    simpleMode: false,
    rideMode: "duplicate",
    // No upgrade locations exist, so the roaming upgrade never spawns.
    upgradeMode: "spawn",
    timedPeriods: 2,
    dayLocations: FORCED_DAY_LOCATIONS,
    nightLocations: FORCED_NIGHT_LOCATIONS,
    locations: { ...FORCED_LOCATIONS },
    neighbourhoods: FORCED_HOOD_COUNT,
    timeStoneReward: FORCED_STONE_REWARD,
    tokenReward: FORCED_TOKEN_REWARD,
    // Sitting a turn out pays time stones here, unlike its siblings. The
    // board's only stone supply is four split circles per seat and they run
    // out — and with nothing happening at the end of a day, the hours running
    // out is the ONLY thing that ends the game. A table that couldn't afford
    // to move the clock would sit on the same hour forever.
    welfareStones: 2,
    begStones: 1
  };
}

function starOverrides(s, stashed) {
  return {
    ...modeCommon(s, stashed),
    landmarkMode: false,
    // No upgrade locations exist, so the roaming upgrade simply never spawns.
    upgradeMode: "spawn",
    dayLocations: STAR_DAY_LOCATIONS,
    nightLocations: STAR_NIGHT_LOCATIONS,
    locations: { ...STAR_LOCATIONS },
    // The rating meter tops out at seven stars.
    ratingMax: RATING_MAX,
    // Star mode goes back to real neighbourhoods — five of them, scored fresh
    // at the end of every day.
    neighbourhoods: STAR_HOOD_COUNT
  };
}

// Normalize a client-submitted settings object; null only when unusable.
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  // The four alternative modes are exclusive: switching one on switches the
  // others off, and the client sends the newly-checked one, so a payload with
  // more than one set falls to the newest arrival (forced, then simple, then
  // star).
  const forcedMode = raw.forcedMode === true;
  const simpleMode = !forcedMode && raw.simpleMode === true;
  const starMode = !forcedMode && !simpleMode && raw.starMode === true;
  const landmarkMode = !forcedMode && !simpleMode && !starMode && raw.landmarkMode === true;
  const anyMode = forcedMode || simpleMode || starMode || landmarkMode;
  // Leaving EVERY mode restores whatever the classic board was before the
  // first of them covered it up.
  const src = !anyMode && raw.classic && typeof raw.classic === "object"
    ? { ...raw, ...raw.classic }
    : raw;
  const locations = {};
  let total = 0;
  for (const type of LOC_TYPES) {
    // Tunings saved before landmark mode call the destinations "uber".
    const fallback = type === "landmark"
      ? (src.locations?.uber ?? BASE_SETTINGS.locations.landmark)
      : BASE_SETTINGS.locations[type];
    const v = intClamp(src.locations?.[type], 0, 30, fallback);
    locations[type] = v;
    total += v;
  }
  if (total < 1) return null; // a board with no locations isn't a game
  const clean = {
    landmarkMode,
    starMode,
    simpleMode,
    forcedMode,
    rideMode: RIDE_MODES.includes(src.rideMode) ? src.rideMode : BASE_SETTINGS.rideMode,
    // "stack" belongs to landmark mode alone (landmarkOverrides sets it) —
    // it would leave the classic board's upgrade locations inert.
    upgradeMode: UPGRADE_MODES.includes(src.upgradeMode) && src.upgradeMode !== "stack"
      ? src.upgradeMode
      : BASE_SETTINGS.upgradeMode,
    timedPeriods: [2, 3].includes(Number(src.timedPeriods)) ? Number(src.timedPeriods) : 0,
    dayLocations: intClamp(src.dayLocations, 0, 60, BASE_SETTINGS.dayLocations),
    nightLocations: intClamp(src.nightLocations, 0, 60, BASE_SETTINGS.nightLocations),
    locations,
    timeStoneReward: intClamp(src.timeStoneReward, 0, 20, BASE_SETTINGS.timeStoneReward),
    tokenReward: intClamp(src.tokenReward, 0, 20, BASE_SETTINGS.tokenReward),
    startingTokens: intClamp(src.startingTokens, 0, 60, BASE_SETTINGS.startingTokens),
    startingTimeStones: intClamp(src.startingTimeStones, 0, 60, BASE_SETTINGS.startingTimeStones),
    startingStress: intClamp(raw.startingStress, STRESS_MIN, STRESS_MAX, BASE_SETTINGS.startingStress),
    tokensPerFail: intClamp(raw.tokensPerFail, 0, 6, BASE_SETTINGS.tokensPerFail),
    neighbourhoods: intClamp(src.neighbourhoods, 1, HOOD_BASE_COLORS.length, BASE_SETTINGS.neighbourhoods),
    days: intClamp(raw.days, 1, 12, BASE_SETTINGS.days),
    ridePoints: intClamp(raw.ridePoints, 0, 12, BASE_SETTINGS.ridePoints),
    redPenalty: intClamp(raw.redPenalty, 0, 12, BASE_SETTINGS.redPenalty),
    colorFirstPoints: intClamp(raw.colorFirstPoints, 0, 12, BASE_SETTINGS.colorFirstPoints),
    colorSecondPoints: intClamp(raw.colorSecondPoints, 0, 12, BASE_SETTINGS.colorSecondPoints),
    upgradePoints: intClamp(raw.upgradePoints, 0, 12, BASE_SETTINGS.upgradePoints),
    landmarkPoints: intClamp(raw.landmarkPoints, 0, 12, BASE_SETTINGS.landmarkPoints),
    mostLandmarksBonus: intClamp(raw.mostLandmarksBonus, 0, 12, BASE_SETTINGS.mostLandmarksBonus),
    finePoints: intClamp(raw.finePoints, 0, 12, BASE_SETTINGS.finePoints),
    cardPenalty: intClamp(raw.cardPenalty, 0, 12, BASE_SETTINGS.cardPenalty),
    shortPenalty: intClamp(raw.shortPenalty, 0, 12, BASE_SETTINGS.shortPenalty),
    startingRating: intClamp(raw.startingRating, 0, RATING_MAX, BASE_SETTINGS.startingRating),
    ratingMax: intClamp(raw.ratingMax, 1, 20, BASE_SETTINGS.ratingMax),
    // One score per possible neighbourhood count, 0 through the mode's five.
    hoodSpread: Array.from({ length: HOOD_SPREAD_SCORE.length }, (_, i) =>
      intClamp(raw.hoodSpread?.[i], 0, 60, HOOD_SPREAD_SCORE[i])),
    starMostBonus: intClamp(raw.starMostBonus, 0, 30, BASE_SETTINGS.starMostBonus),
    starFineBonus: intClamp(raw.starFineBonus, 0, 30, BASE_SETTINGS.starFineBonus),
    simpleStartStars: intClamp(raw.simpleStartStars, 0, SIMPLE_STAR_MAX, BASE_SETTINGS.simpleStartStars),
    simpleFineSwing: intClamp(raw.simpleFineSwing, 0, 30, BASE_SETTINGS.simpleFineSwing),
    forcedCardPoints: intClamp(raw.forcedCardPoints, 0, 12, BASE_SETTINGS.forcedCardPoints),
    forcedMissPenalty: intClamp(raw.forcedMissPenalty, 0, 12, BASE_SETTINGS.forcedMissPenalty),
    forcedFineSwing: intClamp(raw.forcedFineSwing, 0, 30, BASE_SETTINGS.forcedFineSwing),
    forcedCards: intClamp(raw.forcedCards, 1, 8, BASE_SETTINGS.forcedCards),
    welfareTokens: intClamp(src.welfareTokens, 0, 20, BASE_SETTINGS.welfareTokens),
    welfareStones: intClamp(src.welfareStones, 0, 20, BASE_SETTINGS.welfareStones),
    begTokens: intClamp(raw.begTokens, 0, 20, BASE_SETTINGS.begTokens),
    begStones: intClamp(src.begStones, 0, 20, BASE_SETTINGS.begStones),
    blankLights: {
      green: intClamp(raw.blankLights?.green, 0, 30, BASE_SETTINGS.blankLights.green),
      red: intClamp(raw.blankLights?.red, 0, 30, BASE_SETTINGS.blankLights.red)
    }
  };
  if (forcedMode) return forcedOverrides(clean, raw.classic);
  if (simpleMode) return simpleOverrides(clean, raw.classic);
  if (starMode) return starOverrides(clean, raw.classic);
  if (landmarkMode) return landmarkOverrides(clean, raw.classic);
  return clean;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const k = Math.floor(Math.random() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

const freshTurnState = () => ({
  acted: false,       // a token was placed — movement is over
  changedTime: false, // the clock changes once per turn
  truck: null,        // the car locked in as this turn's mover
  dicePool: 0,        // a die per red light crossed, rolled at turn end
  destressed: false,  // this turn visited a destress location — turn must end
  keptGoing: false,   // movement was reopened by taking on stress
  skipped: false,     // the turn was sat out for welfare
  aiLegs: 0,          // AI only: keep-going continuations taken this turn
  // One-step undo: the turn's latest still-revocable action ({kind:"move"} or
  // {kind:"time"}), cleared the moment a token is placed or anything follows.
  undo: null
});

function buildingCentroid(b) {
  if (b.points) {
    let x = 0;
    let y = 0;
    for (const p of b.points) {
      x += p[0];
      y += p[1];
    }
    return [x / b.points.length, y / b.points.length];
  }
  return [b.x + (b.w ?? 0) / 2, b.y + (b.h ?? 0) / 2];
}

// Split the location buildings into geographically coherent neighbourhoods of
// 4–5: even hood sizes, columns of one or two hoods sliced along x, each
// column split along y. Hood ids run 0..k-1 and take the ordered palette.
function partitionHoods(locations, hoodCount) {
  const n = locations.length;
  const k = Math.max(1, Math.min(hoodCount, Math.ceil(n / 2), HOOD_BASE_COLORS.length));
  const sizes = Array.from({ length: k }, (_, i) =>
    Math.floor(n / k) + (i < n % k ? 1 : 0));
  const sorted = locations
    .map((b) => ({ b, c: buildingCentroid(b) }))
    .sort((p, q) => p.c[0] - q.c[0]);
  let cursor = 0;
  let hood = 0;
  while (hood < k) {
    // One column holds the next one or two hoods' worth of locations.
    const colHoods = Math.min(2, k - hood);
    let colN = 0;
    for (let j = 0; j < colHoods; j += 1) colN += sizes[hood + j];
    const col = sorted.slice(cursor, cursor + colN).sort((p, q) => p.c[1] - q.c[1]);
    cursor += colN;
    let inner = 0;
    for (let j = 0; j < colHoods; j += 1) {
      for (let m = 0; m < sizes[hood + j]; m += 1) {
        col[inner].b.hood = hood + j;
        inner += 1;
      }
    }
    hood += colHoods;
  }
  return k;
}

// The neighbourhood list itself: ids 0..k-1 over the ordered palette. Forced
// mode passes its own muted palette instead — its hoods are wallpaper, and the
// standard colors would fight the five player colors on the circles.
const hoodList = (k, palette = null) => (palette ?? hoodPalette(k))
  .slice(0, Math.max(1, k))
  .map((color, i) => ({
    id: i,
    name: HOOD_NAMES[i % HOOD_NAMES.length],
    color
  }));

function assignNeighbourhoods(locations, hoodCount) {
  return hoodList(partitionHoods(locations, hoodCount));
}

// Simple mode deals hood-first: the fifty locations are split into five
// geographically coherent neighbourhoods and each one is then dealt the
// identical ten — 1 time stone, 1 token, 2 discovery, 6 landmarks — so no
// neighbourhood is richer than another. Sets `hood` on every building it
// touches and returns the type for each, aligned with `reachable`.
function simpleTypeDeal(reachable) {
  const picked = reachable.slice(0, SIMPLE_TOTAL);
  partitionHoods(picked, SIMPLE_HOOD_COUNT);
  const byHood = new Map();
  picked.forEach((b, i) => {
    if (!byHood.has(b.hood)) byHood.set(b.hood, []);
    byHood.get(b.hood).push(i);
  });
  const deal = new Array(picked.length);
  for (const idx of byHood.values()) {
    // A short board (a map that couldn't seat fifty) just runs long on
    // landmarks rather than skewing the token locations.
    const bag = [...SIMPLE_HOOD_CIRCLES, ...Array(SIMPLE_HOOD_LANDMARKS).fill("landmark")];
    shuffle(idx).forEach((i, k) => { deal[i] = bag[k] ?? "landmark"; });
  }
  return deal;
}

// Forced mode deals hood-first too, but its neighbourhoods carry no rules —
// they're only there so the board has shapes to navigate by. What the deal
// buys is a spread: each TYPE goes round the seven hoods one at a time, so no
// district ends up all required locations (nothing to earn there) or all
// shared ones (nothing to lose there). Sets `hood` on every building it
// touches and returns the type for each, aligned with `reachable`.
function forcedTypeDeal(reachable) {
  const picked = reachable.slice(0, FORCED_TOTAL);
  partitionHoods(picked, FORCED_HOOD_COUNT);
  const byHood = new Map();
  picked.forEach((b, i) => {
    if (!byHood.has(b.hood)) byHood.set(b.hood, []);
    byHood.get(b.hood).push(i);
  });
  const slots = [...byHood.values()].map((idx) => shuffle(idx));
  const dealt = slots.map(() => []);
  for (const [type, count] of [
    ["required", FORCED_LOCATIONS.required],
    ["token", FORCED_LOCATIONS.token],
    ["timestone", FORCED_LOCATIONS.timestone]
  ]) {
    let placed = 0;
    while (placed < count) {
      let any = false;
      for (const h of shuffle(slots.map((_, i) => i))) {
        if (placed >= count) break;
        if (dealt[h].length >= slots[h].length) continue;
        dealt[h].push(type);
        placed += 1;
        any = true;
      }
      if (!any) break; // a short board — it simply seats fewer
    }
  }
  const deal = new Array(picked.length);
  slots.forEach((idx, h) => {
    idx.forEach((i, k) => { deal[i] = dealt[h][k] ?? "required"; });
  });
  return deal;
}

// Forced mode's ownership pass, run once the types are down and the hoods are
// known. Three things land here:
// — the thirty required locations are split six per seat, spread so a seat
//   rarely owns two in the same neighbourhood (its six are errands to run
//   across the whole city, not one corner of it);
// — each seat's six are timed two by day, two by night, two whenever;
// — the twenty shared locations take the ten pairs of seats, one token
//   location and one time-stone location apiece.
// The board is always dealt for all five seats whether or not five are
// playing — an absent seat's circles just sit there unusable, which is the
// rule as written.
function forcedAssign(locations) {
  const seats = PLAYER_COLORS.map((_, i) => i);
  const required = locations.filter((b) => b.locType === "required");
  const byHood = new Map();
  for (const b of shuffle(required)) {
    if (!byHood.has(b.hood)) byHood.set(b.hood, []);
    byHood.get(b.hood).push(b);
  }
  const need = seats.map(() => FORCED_REQUIRED_PER_SEAT);
  for (const list of shuffle([...byHood.values()])) {
    const here = new Set();
    for (const b of list) {
      const open = seats.filter((s) => need[s] > 0);
      if (!open.length) break; // more required locations than the deal asks for
      // Prefer a seat with no location in this hood yet; among those, the one
      // still owed the most.
      const fresh = open.filter((s) => !here.has(s));
      const pool = fresh.length ? fresh : open;
      const most = Math.max(...pool.map((s) => need[s]));
      const pick = shuffle(pool.filter((s) => need[s] === most))[0];
      b.owner = pick;
      need[pick] -= 1;
      here.add(pick);
    }
  }
  // Each seat's own six: two day, two night, two open whenever.
  for (const s of seats) {
    const mine = shuffle(required.filter((b) => b.owner === s));
    mine.forEach((b, i) => {
      if (i < FORCED_DAY_PER_SEAT) b.period = "day";
      else if (i < FORCED_DAY_PER_SEAT + FORCED_NIGHT_PER_SEAT) b.period = "night";
    });
  }
  // The shared circles: every unordered pair of seats gets one of each kind.
  const pairs = [];
  for (let a = 0; a < seats.length; a += 1) {
    for (let b = a + 1; b < seats.length; b += 1) pairs.push([seats[a], seats[b]]);
  }
  const order = shuffle(pairs);
  const take = (type) => shuffle(locations.filter((b) => b.locType === type));
  take("token").forEach((b, i) => { b.pair = [...order[i % order.length]]; });
  take("timestone").forEach((b, i) => { b.pair = [...order[i % order.length]]; });
}

// Landmark mode's colors: no geography at all — the seven colors are dealt
// four apiece over the token-requiring locations, scattered wherever they
// landed. Landmark destinations belong to no color. Returns the colors list
// (same shape as hoods, so everything downstream reads it the same way).
function assignColors(tokenLocs) {
  const k = Math.min(LANDMARK_COLOR_COUNT, Math.max(1, Math.ceil(tokenLocs.length / LANDMARK_COLOR_SIZE)));
  const bag = [];
  for (let c = 0; c < k; c += 1) {
    for (let i = 0; i < LANDMARK_COLOR_SIZE; i += 1) bag.push(c);
  }
  // A short board (a map that couldn't seat everything) just deals what fits
  // and leaves the tail colorless rather than making lopsided colors.
  const deal = shuffle(bag);
  shuffle(tokenLocs).forEach((b, i) => {
    if (i < deal.length) b.hood = deal[i];
  });
  const palette = hoodPalette(k);
  return palette.map((color, i) => ({
    id: i,
    name: COLOR_NAMES[i % COLOR_NAMES.length],
    color,
    // How many of this color actually made it onto the board — the scoring
    // threshold is "three of four", but a clipped color asks for what it has.
    size: tokenLocs.filter((b) => b.hood === i).length
  }));
}

// Deal the location types over the map's reachable buildings and cluster them
// into neighbourhoods (or, in landmark mode, scatter the seven colors).
// Mutates the map; returns the hoods/colors list.
function assignLocations(map, settings, playerCount = 4) {
  const buildings = (map.blocks ?? []).flatMap((b) => b.buildings ?? []);
  buildings.forEach((b) => {
    b.role = "empty";
    b.color = "#f4f1ea";
    delete b.locType;
    delete b.slots;
    delete b.under;
    delete b.hood;
    delete b.name;
    delete b.emoji;
    delete b.period;
    delete b.upgrade;
    delete b.stackLeft;
    delete b.window;
    delete b.owner;
    delete b.pair;
    // Upgrade locations get trimmed to a single entrance below, and a
    // re-deal can move them — so every deal starts from the full set.
    if (b.baseConnectors) b.connectors = b.baseConnectors.map((c) => ({ ...c }));
    else b.baseConnectors = (b.connectors ?? []).map((c) => ({ ...c }));
  });

  // Duplicate mode: no landmark destinations — every location is a one-circle
  // reward location that doubles as a ride destination.
  const duplicate = settings.rideMode === "duplicate";
  const landmarkMode = settings.landmarkMode === true;
  // Star mode: every token location has ONE circle — first there takes it, and
  // the whole board wipes at the end of each day.
  const starMode = settings.starMode === true;
  // Simple mode deals its types per neighbourhood instead of over the whole
  // board, so the hoods are drawn first and the bag never comes into it.
  const simpleMode = settings.simpleMode === true;
  // Forced mode deals hood-first as well, and does its own owner / pair /
  // day-night pass afterwards — the generic period bag never touches it.
  const forcedMode = settings.forcedMode === true;
  const reachable = shuffle(buildings.filter((b) => (b.connectors ?? []).length > 0));
  const bag = [];
  for (const type of LOC_TYPES) {
    if (duplicate && type === "landmark") continue;
    for (let i = 0; i < (settings.locations[type] ?? 0); i += 1) bag.push(type);
  }
  const deal = forcedMode
    ? forcedTypeDeal(reachable)
    : simpleMode
    ? simpleTypeDeal(reachable)
    : shuffle(bag).slice(0, reachable.length);
  const names = shuffle(LOC_NAMES);
  const places = shuffle(LANDMARK_PLACES);
  const emojis = shuffle(LOC_EMOJIS);
  // Forced mode names every location for its picture — the cards point at
  // them by both, so the name and the emoji have to come off one list.
  const forcedPlaces = shuffle(FORCED_PLACES);
  const timed = [2, 3].includes(settings.timedPeriods ?? 0) ? settings.timedPeriods : 0;
  // The Day, Night scheme deals exactly the settings' day and night counts
  // over the circle locations (shuffled so they spread across types and
  // hoods); every leftover carries no period and opens whenever.
  let dayNightBag = null;
  if (timed === 2 && !simpleMode && !forcedMode) {
    const circleTotal = deal.filter((t) => CIRCLE_TYPES.includes(t)).length;
    const day = Math.min(circleTotal, Math.max(0, settings.dayLocations ?? 0));
    const night = Math.min(circleTotal - day, Math.max(0, settings.nightLocations ?? 0));
    dayNightBag = shuffle([
      ...Array(day).fill("day"),
      ...Array(night).fill("night"),
      ...Array(circleTotal - day - night).fill(null)
    ]);
  }
  // Landmark mode's four upgrade locations wear one named window each.
  const windowBag = shuffle(LANDMARK_WINDOWS.map((_, i) => i));
  let wi = 0;
  let ni = 0;
  let pi = 0;
  let pri = 0; // circle locations dealt — round-robins the periods
  const locations = [];
  deal.forEach((type, i) => {
    const b = reachable[i];
    b.role = "loc";
    b.locType = type;
    if (type === "upgrade" && (b.connectors ?? []).length > 1) {
      // Upgrade locations have one and only one entrance.
      b.connectors = [b.connectors[Math.floor(Math.random() * b.connectors.length)]];
    }
    if (type === "landmark") {
      // A landmark: a big emoji on the board, no token circles — driving
      // there completes matching landmark cards.
      const place = places[pi % places.length];
      const lap = Math.floor(pi / places.length);
      b.name = lap ? `${place.name} ${lap + 1}` : place.name;
      b.emoji = place.emoji;
      pi += 1;
    } else if (forcedMode) {
      // Name and picture off one list, so "Bakery 🥐" reads as one thing and
      // a card pointing at it needs no decoding.
      const place = forcedPlaces[ni % forcedPlaces.length];
      const lap = Math.floor(ni / forcedPlaces.length);
      b.name = lap ? `${place.name} ${lap + 1}` : place.name;
      b.emoji = place.emoji;
      ni += 1;
      b.slots = [null];
      // The day / night gate lands in forcedAssign — only required locations
      // are timed, and only two of each seat's six each way.
    } else {
      b.name = ni < names.length ? names[ni] : `${names[ni % names.length]} ${Math.floor(ni / names.length) + 1}`;
      ni += 1;
      if (landmarkMode && type === "upgrade") {
        // Landmark mode: an upgrade location takes a token like any other,
        // but with ONE circle per player — so every player gets exactly one
        // upgrade from each of the four, and none of them can be hogged.
        // Its window (Morning / Afternoon / Evening / Night) is the only
        // time gate in this mode. The stack is dealt in setupBoard.
        b.slots = Array.from({ length: Math.max(1, playerCount) }, () => null);
        b.window = windowBag[wi % windowBag.length];
        wi += 1;
      } else if (type !== "upgrade") {
        // The token circles: player index or null. One circle in duplicate,
        // star and simple modes, two otherwise. (Classic upgrade locations
        // carry no circles — the roaming upgrade is their whole state.)
        b.slots = duplicate || starMode || simpleMode ? [null] : [null, null];
        // Timed locations: round-robin over the shuffled deal spreads the
        // periods evenly across types and neighbourhoods. The Day, Night
        // scheme leaves every third location unrestricted.
        if (timed === 3) {
          b.period = PERIODS[pri % PERIODS.length];
          pri += 1;
        } else if (timed === 2 && dayNightBag) {
          const p = dayNightBag.length ? dayNightBag.pop() : null;
          if (p) b.period = p;
        }
      }
    }
    // Duplicate mode: every location gets its own emoji for the ride cards.
    // (Forced mode already took a matched name and emoji off one list.)
    if (duplicate && !forcedMode) b.emoji = emojis[i % emojis.length];
    locations.push(b);
  });
  // Landmark mode scatters seven colors over the token-requiring locations
  // only; the classic game clusters every location into neighbourhoods, and
  // simple mode already drew its five before the types were dealt.
  const hoods = landmarkMode
    ? assignColors(locations.filter((b) => Array.isArray(b.slots)))
    : simpleMode
    ? hoodList(new Set(locations.map((b) => b.hood)).size)
    : forcedMode
    ? hoodList(new Set(locations.map((b) => b.hood)).size, FORCED_HOOD_COLORS)
    : assignNeighbourhoods(locations, settings.neighbourhoods);
  // Forced mode's whole board state — who owns which circle, which pairs
  // share which, and which of a seat's six are day or night — lands now that
  // the types and the hoods are both settled.
  if (forcedMode) forcedAssign(locations);
  // Simple mode spreads its day/night gate BY neighbourhood rather than over
  // the board at large: the days go round the hoods one apiece before any hood
  // takes a second, then the nights do the same in the opposite order. With
  // 6 and 6 over five hoods that leaves every hood one or two locations open
  // at any hour — none is ever gated shut, and no hood carries both extras.
  if (simpleMode) {
    const byHood = hoods.map((h) =>
      shuffle(locations.filter((b) => b.hood === h.id && Array.isArray(b.slots))));
    const order = shuffle(byHood.map((_, i) => i));
    const gate = (period, count, hoodOrder) => {
      let placed = 0;
      while (placed < count) {
        let any = false;
        for (const hi of hoodOrder) {
          if (placed >= count) break;
          const b = byHood[hi].find((x) => !x.period);
          if (!b) continue;
          b.period = period;
          placed += 1;
          any = true;
        }
        if (!any) break; // every location is gated already
      }
    };
    gate("day", settings.dayLocations ?? SIMPLE_DAY_LOCATIONS, order);
    gate("night", settings.nightLocations ?? SIMPLE_NIGHT_LOCATIONS, [...order].reverse());
  }
  // Every location wears its color (landmark destinations: neutral stone).
  const colorById = new Map(hoods.map((h) => [h.id, h.color]));
  locations.forEach((b) => {
    b.color = colorById.get(b.hood) ?? (landmarkMode ? NO_COLOR : "#d8d3c8");
  });
  return hoods;
}

function buildingByBid(map, bid) {
  for (const block of map.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      if (b.bid === bid) return b;
    }
  }
  return null;
}

const humanCount = (room) => Math.max(1, new Set(room.players ?? []).size);
const maxAiFor = (room) => PLAYER_COLORS.length - humanCount(room);

export function createLandmarkManiaGame({ io, rooms }) {
  // Saved versions predating newer fields get them clamped/filled on load
  // (sanitizeSettings falls back to the base numbers) and written back.
  let savedSettings = loadSavedSettings()
    .map((e) => ({ ...e, settings: sanitizeSettings(e.settings) ?? cloneSettings(BASE_SETTINGS) }));
  if (savingEnabled && JSON.stringify(savedSettings) !== JSON.stringify(loadSavedSettings())) {
    persistSavedSettings(savedSettings);
  }
  const settingsPayload = () => ({
    settings: savedSettings.map(({ id, name }) => ({ id, name })),
    canSave: savingEnabled
  });

  const S = (room) => room.landmarkMania.settings ?? BASE_SETTINGS;

  // Put a tuning version on the table: apply the numbers and re-deal on a
  // fresh map sized for them.
  function applySettingsToRoom(roomId, room, settings) {
    clearAiTimer(roomId);
    room.landmarkMania.settings = cloneSettings(settings);
    room.landmarkMania.map = makeMap(settings);
    setupBoard(room);
    room.landmarkMania.map.seed = `${room.landmarkMania.map.seed}-t${Date.now()}`;
  }

  // Is this room playing landmark mode?
  const isLandmark = (room) => S(room).landmarkMode === true;
  const isStar = (room) => S(room).starMode === true;
  const isSimple = (room) => S(room).simpleMode === true;
  const isForced = (room) => S(room).forcedMode === true;
  // Everything the four alternative modes share against the classic game: the
  // day/night board, the deeper rests, and the day-split handouts (welfare by
  // day, begging by night). (Forced mode holds no cards face down — its hand
  // is always face up and always full — but it shares everything else.)
  const isNewMode = (room) =>
    isLandmark(room) || isStar(room) || isSimple(room) || isForced(room);

  // How many locations this tuning wants seated.
  const locTotal = (settings) => LOC_TYPES.reduce((n, t) =>
    n + (settings.rideMode === "duplicate" && t === "landmark" ? 0 : settings.locations?.[t] ?? 0), 0);

  function genOpts(settings) {
    const total = locTotal(settings);
    // Exactly 24 numbered lights + the chosen blanks (the four light-free
    // corners come on top inside the generator).
    const lights = 24 + (settings.blankLights?.green ?? 6) + (settings.blankLights?.red ?? 6);
    // Packed lots: locations fill the blocks wall to wall with small gaps.
    // The generator only lands near the building count it's asked for, and a
    // lot with no driveway can't be a location — so ask for a margin over
    // what the deal needs.
    const buildings = total + Math.max(4, Math.ceil(total * 0.16));
    return { dense: true, buildings, intersections: lights, packed: true };
  }

  // Generate a map that can actually seat the whole deal. Landmark mode's
  // board is exact — 50 locations, seven colors of four — so a map that came
  // up short would quietly deal a lopsided game; a couple of rerolls is
  // cheaper than that. (Falls through to the last try if the size asked for
  // is simply more than the generator will fit.)
  function makeMap(settings) {
    const need = locTotal(settings);
    let map = null;
    for (let tries = 0; tries < 6; tries += 1) {
      map = generateCityMap(Date.now() + tries * 7919, genOpts(settings));
      const seats = (map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
        .filter((b) => (b.connectors ?? []).length > 0).length;
      if (seats >= need) break;
    }
    return map;
  }

  // Deal fresh locations, park the cars off-board, reset every player.
  // Humans hold the first seats, AI fill in behind (up to 4 seats total).
  function setupBoard(room) {
    const settings = S(room);
    const humans = humanCount(room);
    const maxAi = maxAiFor(room);
    const aiCount = Math.max(0, Math.min(maxAi, room.landmarkMania.aiCount ?? maxAi));
    room.landmarkMania.aiCount = aiCount;
    // Landmark mode sizes each upgrade location's circles to the table, so
    // the deal needs the seat count.
    room.landmarkMania.hoods = assignLocations(room.landmarkMania.map, settings, humans + aiCount);
    // The deal trims upgrade locations to a single entrance (and a re-deal
    // can move them), so the parking spots are re-derived to match.
    room.landmarkMania.map.spots = deriveSpots(room.landmarkMania.map);
    setBlankLights(
      room.landmarkMania.map.intersections,
      settings.blankLights?.green ?? 6,
      settings.blankLights?.red ?? 6
    );
    room.landmarkMania.trucks = Array.from({ length: humans + aiCount }, (_, i) => ({
      id: i, player: i, spot: null, facing: 0
    }));
    room.landmarkMania.players = room.landmarkMania.trucks.map((t, i) => ({
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      name: i >= humans ? `AI ${i - humans + 1}` : humans === 1 ? "You" : `P${i + 1}`,
      isAI: i >= humans,
      // Both new modes pay off the turn-order advantage: each seat after the
      // first opens on one more token than the seat before it.
      tokens: settings.startingTokens +
        (settings.landmarkMode || settings.starMode || settings.simpleMode ||
         settings.forcedMode ? i : 0),
      timeStones: settings.startingTimeStones,
      stress: settings.startingStress, // marker between stress and stress+1
      // Ride / landmark cards: { id, loc: building bid }. In landmark mode
      // only the first couple are face up — the rest wait in a face-down
      // stack and flip once a turn ends with room for them.
      rides: [],
      ridesCompleted: 0,
      upgrades: [],       // upgrade type ids picked up (see UPGRADE_TYPES)
      redTokensLost: 0,   // tokens paid to failed dice — the modes' "fines"
      // Landmark mode's two running point penalties, tallied as they happen
      // and only revealed in the end-game chart.
      cardPenalties: 0,   // face-down cards caught by the end of a night
      shortPenalties: 0,  // tokens come up short when the dice asked to be paid
      // Star mode: the driver's rating (whole and half stars) and the running
      // score, both public — cards pay the rating rounded down, on the spot,
      // and each day's neighbourhood spread pays at dawn.
      rating: settings.simpleMode
        ? (settings.simpleStartStars ?? SIMPLE_START_STARS)
        : (settings.startingRating ?? RATING_START),
      points: 0,
      // Simple mode: cards lost face down at a day's end, and stars docked for
      // fines there were no tokens left to cover — both for the final chart.
      cardsExpired: 0,
      starsLost: 0
    }));
    room.landmarkMania.time = START_TIME;
    room.landmarkMania.elapsed = 0; // hours the clock has been moved, total
    room.landmarkMania.pendingDawn = 0; // dawns rolled past but not yet reckoned
    room.landmarkMania.turn = 0;
    room.landmarkMania.turnState = freshTurnState();
    room.landmarkMania.lastRoll = null;
    room.landmarkMania.rideSeq = 0;
    if (settings.forcedMode) {
      // Forced mode is the one new mode that opens on a hand: two face-up
      // cards, and it stays two — the end of every turn tops it back up.
      // (Cars start off-board, so there's no neighbourhood to steer clear of
      // yet.)
      const want = Math.max(1, settings.forcedCards ?? FORCED_CARDS);
      for (const p of room.landmarkMania.players) {
        for (let k = 0; k < want; k += 1) dealRide(room, p, null, false);
      }
      room.landmarkMania.colorClaims = {};
    } else if (settings.landmarkMode || settings.starMode || settings.simpleMode) {
      // None of the other new modes deal a card at setup — every one is picked
      // up at a discovery location. (Landmark mode opens its color race here.)
      room.landmarkMania.colorClaims = {};
    } else if (settings.rideMode !== "ride-pickup") {
      // Ride-2: everyone opens on two face-up ride cards (cars start
      // off-board, so no neighbourhood to steer clear of yet).
      for (const p of room.landmarkMania.players) {
        dealRide(room, p, null, false);
        dealRide(room, p, null, false);
      }
    }
    room.landmarkMania.winner = null;
    room.landmarkMania.results = null;
    room.landmarkMania.funRoll = null;
    // The race to fill all four upgrade slots: seats in finishing order,
    // scored 7 / 5 / 3 / 1 in the classic game, a flat bonus for the first
    // in landmark mode.
    room.landmarkMania.upgradeChampions = [];
    // The upgrade supply: a shuffled depleting deck — two copies of every
    // base type plus one neighbourhood upgrade per hood (landmark mode has no
    // neighbourhoods, so just the base types). Once it's empty no new upgrade
    // appears on the board.
    room.landmarkMania.upgradeDeck = shuffle([
      ...UPGRADE_TYPES, ...UPGRADE_TYPES,
      ...(settings.landmarkMode ? [] : (room.landmarkMania.hoods ?? []).map((h) => `hood:${h.id}`))
    ]);
    if (settings.upgradeMode === "stack") {
      // Landmark mode: each of the four upgrade locations holds a face-up
      // STACK dealt off the deck. You take the top one — paying a token onto
      // your own circle — and the next one shows. A stack only needs to be
      // as deep as the table (one pull per player), so the deck is split
      // evenly and the rest never comes into play.
      room.landmarkMania.upgradeAt = null;
      room.landmarkMania.upgradeType = null;
      const locs = shuffle((room.landmarkMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
        .filter((b) => b.role === "loc" && b.locType === "upgrade"));
      // Only the top of a stack is public — the rest lives server-side so the
      // map going over the wire never spoils what's underneath.
      const stacks = (room.landmarkMania.upgradeStacks = {});
      const depth = Math.max(1, humans + aiCount);
      locs.forEach((b) => {
        const stack = [];
        for (let i = 0; i < depth; i += 1) {
          const type = drawUpgrade(room);
          if (type) stack.push(type);
        }
        b.upgrade = stack.shift() ?? null; // the face-up top
        b.stackLeft = stack.length;        // how many wait beneath it
        stacks[b.bid] = stack;
      });
    } else if (settings.upgradeMode === "scheduled") {
      // Scheduled mode: every upgrade location shows a dealt upgrade from
      // the start, each behind its own 4-hour window (round-robined over a
      // shuffled order). Taken upgrades never respawn.
      room.landmarkMania.upgradeAt = null;
      room.landmarkMania.upgradeType = null;
      const locs = shuffle((room.landmarkMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
        .filter((b) => b.role === "loc" && b.locType === "upgrade"));
      locs.forEach((b, i) => {
        b.window = i % UPGRADE_WINDOW_COUNT;
        b.upgrade = drawUpgrade(room); // null once the deck runs dry
      });
    } else {
      // One roaming upgrade: it starts at a random upgrade location and hops
      // to another (as the next draw from the deck) whenever someone picks it
      // up.
      room.landmarkMania.upgradeAt = pickUpgradeLocation(room, null);
      room.landmarkMania.upgradeType = room.landmarkMania.upgradeAt != null ? drawUpgrade(room) : null;
    }
    room.landmarkMania.aiGraph = null; // rebuilt lazily against the current map
    room.landmarkMania.aiMove = null;  // transient: an AI's drive, for the clients to animate
  }

  // Draw the next upgrade off the depleting deck (null once it runs dry).
  function drawUpgrade(room) {
    const deck = room.landmarkMania.upgradeDeck ?? [];
    return deck.length ? deck.pop() : null;
  }

  // How many upgrades this player may hold: two by default, a third slot for
  // a token in every neighbourhood, a fourth for two in every neighbourhood.
  // Only top-of-circle tokens count (undercut tokens sit beneath and don't);
  // a hood with fewer claimable locations than the requirement only demands
  // what it has, so a thin hood can't lock the slots forever.
  function upgradeCap(room, seat) {
    // Landmark mode: four upgrade locations, one circle each per player —
    // the board itself is the cap, so the player sheet just holds four.
    if (isStar(room)) return 0;   // no upgrade locations in star mode
    if (isLandmark(room)) return LANDMARK_WINDOWS.length;
    const total = new Map();
    const have = new Map();
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role !== "loc" || !Array.isArray(b.slots) || b.hood == null) continue;
        total.set(b.hood, (total.get(b.hood) ?? 0) + 1);
        if (b.slots.includes(seat)) have.set(b.hood, (have.get(b.hood) ?? 0) + 1);
      }
    }
    if (!total.size) return 2;
    const meets = (n) =>
      [...total.entries()].every(([h, t]) => (have.get(h) ?? 0) >= Math.min(n, t));
    let cap = 2;
    if (meets(1)) cap += 1;
    if (meets(2)) cap += 1;
    return cap;
  }

  // This player's top-token count in one neighbourhood (slot-unlock progress).
  function hoodVisits(room, seat, hood) {
    let n = 0;
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role === "loc" && b.hood === hood && Array.isArray(b.slots) && b.slots.includes(seat)) n += 1;
      }
    }
    return n;
  }

  // The clock only ever runs forward, and the game opens at 7am — so a day
  // ends (6am rolls into 7am) exactly when `elapsed` crosses a multiple of 24.
  // Push the clock through this and every day it passes closes out.
  // The clock and the day/night board move the INSTANT the hand does — roll
  // past 6am and the sun locations are open to you right away. What waits is
  // the reckoning: the neighbourhood scoring, the late-card charge and the
  // board wipe all sit pending until the player who pushed the clock over ends
  // their turn. That's deliberate — whoever ends the day pays the least for
  // it, so somebody is always willing to, and they get their last actions
  // (delivering a card, taking a final circle) before the sweep lands.
  function runClock(room, hours) {
    const before = room.landmarkMania.elapsed ?? 0;
    const after = before + Math.max(0, hours);
    room.landmarkMania.elapsed = after;
    room.landmarkMania.time = (room.landmarkMania.time ?? START_TIME) + Math.max(0, hours);
    room.landmarkMania.time = ((room.landmarkMania.time % 24) + 24) % 24;
    const nights = Math.floor(after / 24) - Math.floor(before / 24);
    if (nights > 0) room.landmarkMania.pendingDawn = (room.landmarkMania.pendingDawn ?? 0) + nights;
    return nights;
  }

  // Cash in whatever dawns the clock has rolled past this turn.
  function settleDawn(room) {
    const owed = room.landmarkMania.pendingDawn ?? 0;
    if (owed <= 0) return 0;
    room.landmarkMania.pendingDawn = 0;
    endOfDay(room, owed);
    return owed;
  }

  // A day has ended. Landmark mode bills every card still face down. Star and
  // simple modes do their whole daily reckoning here: score the neighbourhoods
  // off the tokens standing on the board, settle the day's cards, then sweep
  // every token off the board so the next day starts clean. (Spent tokens are
  // spent — they don't come back to their owner.)
  function endOfDay(room, nights = 1) {
    if (isSimple(room)) {
      // The day pays in STARS, up to two of them, and both halves are asked
      // for at once: how far the player spread, and how clean their hand is.
      // Districts — a token in every neighbourhood is a full star, one short
      // is a half. Cards — an entirely empty hand is a full star, nothing
      // face down (a card or two still showing) is a half. Only then do the
      // buried cards expire, and the board wipes for the new day.
      const cap = S(room).ratingMax ?? SIMPLE_STAR_MAX;
      const total = (room.landmarkMania.hoods ?? []).length;
      for (let n = 0; n < nights; n += 1) {
        (room.landmarkMania.players ?? []).forEach((p, seat) => {
          let gain = 0;
          const hoods = hoodSpread(room, seat);
          if (total > 0 && hoods >= total) gain += SIMPLE_STAR_STEP;
          else if (total > 1 && hoods >= total - 1) gain += SIMPLE_HALF_STEP;
          const rides = p.rides ?? [];
          const buried = rides.filter((r) => r.faceDown).length;
          if (rides.length === 0) gain += SIMPLE_STAR_STEP;
          else if (buried === 0) gain += SIMPLE_HALF_STEP;
          p.rating = Math.min(cap, (p.rating ?? 0) + gain);
          if (buried > 0) {
            p.cardsExpired = (p.cardsExpired ?? 0) + buried;
            p.rides = rides.filter((r) => !r.faceDown);
          }
        });
        clearBoardTokens(room);
      }
      return;
    }
    if (isLandmark(room)) {
      const per = S(room).cardPenalty ?? 1;
      if (per <= 0) return;
      for (const p of room.landmarkMania.players ?? []) {
        const down = (p.rides ?? []).filter((r) => r.faceDown).length;
        if (down > 0) p.cardPenalties = (p.cardPenalties ?? 0) + down * per * nights;
      }
      return;
    }
    if (!isStar(room)) return;
    const spread = S(room).hoodSpread ?? HOOD_SPREAD_SCORE;
    const cap = S(room).ratingMax ?? RATING_MAX;
    // More than one day at once only really happens on a huge clock sweep; the
    // board is empty after the first, so the later days score nothing but
    // still charge for late cards.
    for (let n = 0; n < nights; n += 1) {
      (room.landmarkMania.players ?? []).forEach((p, seat) => {
        const hoods = hoodSpread(room, seat);
        p.points = (p.points ?? 0) + (spread[Math.min(hoods, spread.length - 1)] ?? 0);
        const late = (p.rides ?? []).length;
        if (late > 0) {
          p.rating = Math.max(0, Math.min(cap, (p.rating ?? 0) - late * LATE_STEP));
        }
      });
      clearBoardTokens(room);
    }
  }

  // How many DIFFERENT neighbourhoods this player has a token standing in
  // right now. (Completing a landmark card puts no token down, so it never
  // counts toward the spread.)
  function hoodSpread(room, seat) {
    const seen = new Set();
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role !== "loc" || b.hood == null || !Array.isArray(b.slots)) continue;
        if (b.slots.includes(seat)) seen.add(b.hood);
      }
    }
    return seen.size;
  }

  // Star mode's dawn sweep: every token comes off the board and every location
  // reopens for the new day.
  function clearBoardTokens(room) {
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (Array.isArray(b.slots)) b.slots = b.slots.map(() => null);
        if (b.under) b.under = [];
      }
    }
  }

  // Landmark mode's colors. Three of a color's four locations claims it: the
  // first player there scores 2, the second 1. `colorClaims[colorId]` is the
  // seats that hit three, in the order they did it.
  const COLOR_TARGET = 3;

  // How many of one color this player holds a top circle at. (Undercut
  // tokens sit beneath and never count, same as the classic slot unlocks.)
  function colorProgress(room, seat, color) {
    let n = 0;
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role === "loc" && b.hood === color && Array.isArray(b.slots) && b.slots.includes(seat)) n += 1;
      }
    }
    return n;
  }

  // What a color asks for: three of four, or all of a color the board could
  // only fit fewer of.
  function colorTarget(room, color) {
    const size = (room.landmarkMania.hoods ?? []).find((h) => h.id === color)?.size ?? LANDMARK_COLOR_SIZE;
    return Math.min(COLOR_TARGET, Math.max(1, size));
  }

  // Called after a token lands: if this player just reached the color's
  // target and isn't already on its list, they take the next place on it.
  function noteColorClaim(room, seat, color) {
    if (!isLandmark(room) || color == null) return;
    const claims = (room.landmarkMania.colorClaims ??= {});
    const list = (claims[color] ??= []);
    if (list.includes(seat)) return;
    if (colorProgress(room, seat, color) >= colorTarget(room, color)) list.push(seat);
  }


  // A random upgrade location other than `notBid` — falling back to `notBid`
  // itself when it's the only one, or null when the board has none.
  function pickUpgradeLocation(room, notBid) {
    const locs = (room.landmarkMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
      .filter((b) => b.role === "loc" && b.locType === "upgrade");
    const others = locs.filter((b) => b.bid !== notBid);
    const pool = others.length ? others : locs;
    if (!pool.length) return null;
    return pool[Math.floor(Math.random() * pool.length)].bid;
  }

  // Final scoring: points per completed ride, the upgrade race (7 points for
  // the first player to fill all four slots, then 5, 3, 1), and the red-light
  // swing — every player tied for most tokens lost pays it, every player tied
  // for least collects it (with one player, or everyone tied, both apply and
  // cancel out). Neighbourhood visits score nothing — they unlock slots.
  // Landmark-mode scoring. Colors: 2 to the first player to claim each of the
  // seven, 1 to the second (21 on the table). Upgrades: 1 apiece. Landmark
  // cards: 1 per card completed, plus a bonus shared by everyone tied for the
  // most. Fines (tokens paid to failed dice): the player(s) who paid the
  // FEWEST collect a bonus — paying the most costs nothing extra. Then the two
  // running penalties come off: cards caught face down at the end of a night,
  // and tokens come up short when the dice asked to be paid. Equal totals
  // break on fewest fines — and if that's equal too, they simply tie.
  function finalizeLandmark(room) {
    const settings = S(room);
    const players = room.landmarkMania.players ?? [];
    const claims = room.landmarkMania.colorClaims ?? {};
    const fines = players.map((p) => p.redTokensLost ?? 0);
    const leastFines = Math.min(...fines);
    const doneCounts = players.map((p) => p.ridesCompleted ?? 0);
    const mostDone = Math.max(...doneCounts);

    const perPlayer = players.map((p, i) => {
      // Colors claimed, and what each place paid.
      let colorPts = 0;
      const colorsFirst = [];
      const colorsSecond = [];
      for (const h of room.landmarkMania.hoods ?? []) {
        const place = (claims[h.id] ?? []).indexOf(i);
        if (place === 0) {
          colorPts += settings.colorFirstPoints ?? 2;
          colorsFirst.push(h.id);
        } else if (place === 1) {
          colorPts += settings.colorSecondPoints ?? 1;
          colorsSecond.push(h.id);
        }
      }
      const upgrades = (p.upgrades ?? []).length;
      const upgradePts = upgrades * (settings.upgradePoints ?? 1);
      const landmarks = p.ridesCompleted ?? 0;
      // The "most cards" bonus only pays when somebody actually finished one.
      const mostBonus = mostDone > 0 && landmarks === mostDone
        ? (settings.mostLandmarksBonus ?? 2)
        : 0;
      const landmarkPts = landmarks * (settings.landmarkPoints ?? 1) + mostBonus;
      // Fewest fines is worth a bonus; paying the most simply costs the
      // tokens it already cost.
      const fineAdj = (p.redTokensLost ?? 0) === leastFines ? (settings.finePoints ?? 2) : 0;
      // The two running penalties, revealed only now.
      const cardPen = p.cardPenalties ?? 0;
      const shortPen = p.shortPenalties ?? 0;
      const penalties = cardPen + shortPen;
      return {
        colorsFirst, colorsSecond, colorPts,
        upgrades, upgradePts,
        landmarks, mostBonus, landmarkPts,
        fines: p.redTokensLost ?? 0, fineAdj,
        cardPen, shortPen, penalties,
        total: colorPts + upgradePts + landmarkPts + fineAdj - penalties
      };
    });

    const best = Math.max(...perPlayer.map((r) => r.total));
    const topSeats = perPlayer.map((r, i) => (r.total === best ? i : -1)).filter((i) => i !== -1);
    // Tiebreak among the leaders: fewest fines paid. Still level? They tie.
    const fewest = Math.min(...topSeats.map((i) => perPlayer[i].fines));
    const winners = topSeats.filter((i) => perPlayer[i].fines === fewest);
    perPlayer.forEach((r, i) => {
      r.tiebroken = topSeats.length > winners.length && topSeats.includes(i);
    });
    room.landmarkMania.results = { mode: "landmark", perPlayer, winners };
    room.landmarkMania.winner = winners[0] ?? null;
  }

  // Star-mode scoring. Almost everything already happened live: cards paid the
  // driver's rating as they were delivered, and each day's neighbourhood
  // spread paid at dawn. Two bonuses land at the end, and each is SPLIT
  // between everyone tied for it — most landmark cards completed, and fewest
  // fines paid.
  function finalizeStar(room) {
    const settings = S(room);
    const players = room.landmarkMania.players ?? [];
    const done = players.map((p) => p.ridesCompleted ?? 0);
    const fines = players.map((p) => p.redTokensLost ?? 0);
    const mostDone = Math.max(...done);
    const leastFines = Math.min(...fines);
    // Nobody delivered anything — the cards bonus simply isn't awarded.
    const doneWinners = mostDone > 0 ? done.filter((d) => d === mostDone).length : 0;
    const fineWinners = fines.filter((f) => f === leastFines).length;
    const mostShare = doneWinners ? (settings.starMostBonus ?? 6) / doneWinners : 0;
    const fineShare = fineWinners ? (settings.starFineBonus ?? 6) / fineWinners : 0;

    const perPlayer = players.map((p, i) => {
      const live = p.points ?? 0;
      const mostBonus = mostDone > 0 && done[i] === mostDone ? mostShare : 0;
      const fineBonus = fines[i] === leastFines ? fineShare : 0;
      return {
        live,
        rating: p.rating ?? 0,
        landmarks: done[i],
        mostBonus,
        fines: fines[i],
        fineBonus,
        total: live + mostBonus + fineBonus
      };
    });

    const best = Math.max(...perPlayer.map((r) => r.total));
    const winners = perPlayer.map((r, i) => (r.total === best ? i : -1)).filter((i) => i !== -1);
    room.landmarkMania.results = { mode: "star", perPlayer, winners };
    room.landmarkMania.winner = winners[0] ?? null;
  }

  // Simple-mode scoring. Nothing was banked along the way: the whole game is
  // completed landmarks TIMES the star rating those days earned, so a driver
  // with a fistful of cards and no stars scores as badly as a five-star one
  // who delivered nothing. On top of that, the fine swing — every player tied
  // for fewest fines gains it, every player tied for most loses it (with one
  // player, or everyone level, both apply and cancel out).
  function finalizeSimple(room) {
    const settings = S(room);
    const players = room.landmarkMania.players ?? [];
    const fines = players.map((p) => p.redTokensLost ?? 0);
    const leastFines = Math.min(...fines);
    const mostFines = Math.max(...fines);
    const swing = settings.simpleFineSwing ?? 3;

    const perPlayer = players.map((p) => {
      const landmarks = p.ridesCompleted ?? 0;
      const stars = p.rating ?? 0;
      const base = landmarks * stars;
      let fineAdj = 0;
      if ((p.redTokensLost ?? 0) === leastFines) fineAdj += swing;
      if ((p.redTokensLost ?? 0) === mostFines) fineAdj -= swing;
      return {
        landmarks,
        stars,
        base,
        expired: p.cardsExpired ?? 0,
        starsLost: p.starsLost ?? 0,
        fines: p.redTokensLost ?? 0, fineAdj,
        total: base + fineAdj
      };
    });

    const best = Math.max(...perPlayer.map((r) => r.total));
    const winners = perPlayer.map((r, i) => (r.total === best ? i : -1)).filter((i) => i !== -1);
    room.landmarkMania.results = { mode: "simple", perPlayer, winners };
    room.landmarkMania.winner = winners[0] ?? null;
  }

  // Forced-mode scoring, and there is very little of it — which is the point.
  // A point for each landmark card completed, a point OFF for each required
  // location of your color still standing empty (they never came off the
  // board, so this is just a count), and a ±1 swing on fines. Equal totals
  // break on fewest fines paid, and only then tie.
  function finalizeForced(room) {
    const settings = S(room);
    const players = room.landmarkMania.players ?? [];
    const fines = players.map((p) => p.redTokensLost ?? 0);
    const leastFines = Math.min(...fines);
    const mostFines = Math.max(...fines);
    const swing = settings.forcedFineSwing ?? 1;
    const per = settings.forcedCardPoints ?? 1;
    const miss = settings.forcedMissPenalty ?? 1;

    // Every required circle on the board, by owner: covered or not.
    const owned = players.map(() => ({ total: 0, covered: 0 }));
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role !== "loc" || b.locType !== "required") continue;
        const row = owned[b.owner];
        if (!row) continue; // a seat nobody played — its circles score nothing
        row.total += 1;
        if ((b.slots ?? []).includes(b.owner)) row.covered += 1;
      }
    }

    const perPlayer = players.map((p, i) => {
      const cards = p.ridesCompleted ?? 0;
      const cardPts = cards * per;
      const { total, covered } = owned[i] ?? { total: 0, covered: 0 };
      const missed = total - covered;
      let fineAdj = 0;
      if ((p.redTokensLost ?? 0) === leastFines) fineAdj += swing;
      if ((p.redTokensLost ?? 0) === mostFines) fineAdj -= swing;
      return {
        cards, cardPts,
        required: total, covered, missed, missPts: missed * miss,
        fines: p.redTokensLost ?? 0, fineAdj,
        total: cardPts - missed * miss + fineAdj
      };
    });

    const best = Math.max(...perPlayer.map((r) => r.total));
    const topSeats = perPlayer.map((r, i) => (r.total === best ? i : -1)).filter((i) => i !== -1);
    const fewest = Math.min(...topSeats.map((i) => perPlayer[i].fines));
    const winners = topSeats.filter((i) => perPlayer[i].fines === fewest);
    perPlayer.forEach((r, i) => {
      r.tiebroken = topSeats.length > winners.length && topSeats.includes(i);
    });
    room.landmarkMania.results = { mode: "forced", perPlayer, winners };
    room.landmarkMania.winner = winners[0] ?? null;
  }

  function finalizeGame(room) {
    if (isForced(room)) return finalizeForced(room);
    if (isSimple(room)) return finalizeSimple(room);
    if (isStar(room)) return finalizeStar(room);
    if (isLandmark(room)) return finalizeLandmark(room);
    const settings = S(room);
    const players = room.landmarkMania.players ?? [];
    const losses = players.map((p) => p.redTokensLost ?? 0);
    const mostLost = Math.max(...losses);
    const leastLost = Math.min(...losses);
    const champs = room.landmarkMania.upgradeChampions ?? [];
    const perPlayer = players.map((p, i) => {
      const rides = p.ridesCompleted ?? 0;
      const ridePts = rides * (settings.ridePoints ?? 2);
      const rank = champs.indexOf(i);
      const upgradePts = rank === -1 ? 0 : Math.max(1, 7 - 2 * rank);
      let redAdj = 0;
      if ((p.redTokensLost ?? 0) === leastLost) redAdj += settings.redPenalty ?? 3;
      if ((p.redTokensLost ?? 0) === mostLost) redAdj -= settings.redPenalty ?? 3;
      return {
        rides, ridePts,
        upgrades: (p.upgrades ?? []).length, upgradePts,
        redLost: p.redTokensLost ?? 0, redAdj,
        total: ridePts + upgradePts + redAdj
      };
    });
    const best = Math.max(...perPlayer.map((r) => r.total));
    const winners = perPlayer.map((r, i) => (r.total === best ? i : -1)).filter((i) => i !== -1);
    room.landmarkMania.results = { perPlayer, winners };
    room.landmarkMania.winner = winners[0] ?? null;
  }

  function emitState(roomId, room) {
    const time = room.landmarkMania.time ?? START_TIME;
    io.to(roomId).emit("state_update", {
      landmarkMania: {
        map: room.landmarkMania.map,
        hoods: room.landmarkMania.hoods ?? [],
        hour: faceHour(time),
        time,
        night: isNight(time),
        turn: room.landmarkMania.turn ?? 0,
        turnState: room.landmarkMania.turnState ?? freshTurnState(),
        winner: room.landmarkMania.winner ?? null,
        results: room.landmarkMania.results ?? null,
        elapsed: room.landmarkMania.elapsed ?? 0,
        speed: roomSpeed(room),
        settings: S(room),
        upgradeAt: room.landmarkMania.upgradeAt ?? null,
        upgradeType: room.landmarkMania.upgradeType ?? null,
        // Scheduled and stack modes have no supply deck in play — the count is
        // how many upgrades are still waiting on the board (tops plus the
        // hidden cards under them).
        upgradeDeckCount: ["scheduled", "stack"].includes(S(room).upgradeMode)
          ? (room.landmarkMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
            .reduce((n, b) => n + (b.upgrade ? 1 : 0) + (b.stackLeft ?? 0), 0)
          : (room.landmarkMania.upgradeDeck ?? []).length,
        upgradeChampions: room.landmarkMania.upgradeChampions ?? [],
        // Landmark mode: which seats have claimed each color, in order (the
        // first two on a list score 2 and 1).
        colorClaims: room.landmarkMania.colorClaims ?? {},
        maxAi: maxAiFor(room), // free seats — bounds the AI-count picker
        aiMove: room.landmarkMania.aiMove ?? null,
        // A car to put back without animating (an undone move) — position and
        // facing both, since the client has no route to replay.
        snapCar: room.landmarkMania.snapCar ?? null,
        // Forced mode: the last split-circle payout, so the seat that got
        // handed half of somebody else's shopping trip finds out about it.
        share: room.landmarkMania.share ?? null,
        trucks: room.landmarkMania.trucks,
        // Each player carries their current upgrade capacity (2–4 slots).
        players: (room.landmarkMania.players ?? []).map((p, i) => ({
          ...p, upgradeCap: upgradeCap(room, i)
        })),
        lastRoll: room.landmarkMania.lastRoll ?? null,
        funRoll: room.landmarkMania.funRoll ?? null
      },
      turn: room.turn
    });
  }

  function playerRoom(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "landmark-mania") return null;
    if (!room.players.includes(socket.id)) return null;
    return room;
  }

  const seatOf = (room, socket) => room.players.indexOf(socket.id);
  const roomSpeed = (room) => Math.min(3, Math.max(1, room.landmarkMania.speed ?? 3));

  function humanTruck(room, seat, truckId) {
    const t = (room.landmarkMania.trucks ?? []).find((x) => x.id === truckId);
    if (!t || t.player !== seat) return null;
    const ts = room.landmarkMania.turnState;
    if (ts.truck !== null && ts.truck !== truckId) return null;
    return t;
  }

  // The building the car's parking spot belongs to.
  function buildingAtTruck(room, truck) {
    const spot = room.landmarkMania.map.spots?.[truck.spot];
    return spot ? buildingByBid(room.landmarkMania.map, spot.building) : null;
  }

  // Arriving at a ride card's destination completes it — every matching card
  // at once — and counts as the turn's action: movement ends, and only "keep
  // going" (a stress level) reopens it. In ride-2 mode every completed card is
  // replaced with a fresh one on the spot.
  function resolveRidesAt(room, truck, player) {
    // Duplicate mode: nothing completes on arrival — completing is an explicit
    // choice (instead of visiting), via completeRideCore.
    if (S(room).rideMode === "duplicate") return;
    if (!player?.rides?.length) return;
    const b = buildingAtTruck(room, truck);
    if (!b || b.role !== "loc" || b.locType !== "landmark") return;
    // Face-down cards are inert — they only join the hand when the turn ends.
    const done = player.rides.filter((r) => r.loc === b.bid && !r.faceDown).length;
    if (!done) return;
    player.rides = player.rides.filter((r) => r.loc !== b.bid || r.faceDown);
    player.ridesCompleted = (player.ridesCompleted ?? 0) + done;
    // Star mode pays for a delivery on the spot: the driver's rating rounded
    // DOWN, per card. (How many you've completed stays your business — only
    // the running score is public.)
    if (isStar(room)) {
      player.points = (player.points ?? 0) + done * Math.floor(player.rating ?? 0);
    }
    // Simple mode pays nothing now — a completed card is one multiplier of
    // the final landmarks × stars, and `ridesCompleted` already counts it.
    // Neither new mode replaces a completed card — new ones only come from
    // pickup locations, and the face-down stack only flips at turn's end.
    if (!isNewMode(room) && S(room).rideMode !== "ride-pickup") {
      for (let i = 0; i < done; i += 1) dealRide(room, player, b);
    }
    const ts = room.landmarkMania.turnState;
    ts.truck = truck.id;
    ts.acted = true; // the completed ride is the turn's action (undo can revoke it)
  }

  // Park the car and bank a die per red light crossed (rolled at turn end).
  function applyMove(room, truck, spot, reds) {
    truck.spot = spot;
    const player = room.landmarkMania.players?.[truck.player];
    const n = Number.isInteger(reds) ? Math.max(0, Math.min(12, reds)) : 0;
    const ts = room.landmarkMania.turnState;
    ts.dicePool = Math.min(12, (ts.dicePool ?? 0) + n);
    room.landmarkMania.lastRoll = null;
    resolveRidesAt(room, truck, player);
  }

  // Deal a ride / landmark card: a random OTHER landmark location on the board
  // — never one the player already holds a card for (a hand carries no
  // duplicates; if every destination is held, nothing is dealt), and never one
  // in the neighbourhood the player is standing in (`from` is the building
  // they're at, or null off-board), unless every other landmark shares it.
  // Cards dealt mid-turn arrive face down: inert until the turn ends and they
  // flip up (the classic setup deal is face up — that game opens on known
  // cards; landmark mode opens on none at all).
  function dealRide(room, player, from = null, faceDown = true) {
    // Destinations: landmark locations — or, in duplicate mode, any location.
    const duplicate = S(room).rideMode === "duplicate";
    const held = new Set((player.rides ?? []).map((r) => r.loc));
    const dests = (room.landmarkMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
      .filter((b) => b.role === "loc" && (duplicate || b.locType === "landmark") &&
        b.bid !== from?.bid && !held.has(b.bid));
    if (!dests.length) return;
    const otherHood = from?.hood != null ? dests.filter((b) => b.hood !== from.hood) : dests;
    const locs = (otherHood.length ? otherHood : dests).map((b) => b.bid);
    room.landmarkMania.rideSeq = (room.landmarkMania.rideSeq ?? 0) + 1;
    const ride = {
      id: `r${room.landmarkMania.rideSeq}`,
      loc: locs[Math.floor(Math.random() * locs.length)]
    };
    if (faceDown) ride.faceDown = true;
    player.rides.push(ride);
  }

  // Landmark mode: a player sees ONE card at a time (two with extra ride).
  // Everything past that waits face down in a stack beside the player board —
  // and every night that ends with cards still in it costs points.
  // Landmark mode shows one card (two with extra ride); star and simple modes
  // show two flat — they have no upgrades to widen the window.
  const RIDE_VISIBLE_BASE = 1;
  // Forced mode's hand is the whole hand: nothing is ever face down there, so
  // the cap only ever has to be as wide as the hand it tops up to.
  const visibleRideCap = (room, player) => (isStar(room)
    ? STAR_VISIBLE_CARDS
    : isSimple(room)
    ? SIMPLE_VISIBLE_CARDS
    : isForced(room)
    ? Math.max(1, S(room).forcedCards ?? FORCED_CARDS)
    : RIDE_VISIBLE_BASE + (hasUp(player, "extraRide") ? 1 : 0));

  // Turn's over, dice rolled: face-down cards flip up now, and only now —
  // completing a card mid-turn doesn't pull the next one up behind it. The
  // classic game has no stack, so everything drawn this turn simply flips.
  function flipRides(room, player) {
    const rides = player?.rides ?? [];
    if (!isNewMode(room)) {
      for (const r of rides) delete r.faceDown;
      return;
    }
    const cap = visibleRideCap(room, player);
    let up = rides.filter((r) => !r.faceDown).length;
    for (const r of rides) {
      if (up >= cap) break;
      if (!r.faceDown) continue;
      delete r.faceDown;
      up += 1;
    }
  }

  // Forced mode's split circles. Only one of the two named seats will ever
  // stand on one — but the other collects HALF the reward the moment it
  // happens, wherever they are and whatever they were doing. It's the mode's
  // one piece of give-and-take: there is no way to go shopping without tipping
  // somebody off, and which somebody is a real part of the decision.
  // `share` is a running note for the clients to flash; it carries a seq so a
  // re-render doesn't replay it.
  function shareWithPair(room, b, seat, kind) {
    if (!Array.isArray(b.pair)) return;
    const other = b.pair.find((s) => s !== seat);
    const partner = other != null ? room.landmarkMania.players?.[other] : null;
    if (!partner) return; // a seat nobody is playing — the half simply lapses
    const settings = S(room);
    const full = kind === "stones"
      ? (settings.timeStoneReward ?? FORCED_STONE_REWARD)
      : (settings.tokenReward ?? FORCED_TOKEN_REWARD);
    const half = Math.floor(full / 2);
    if (half <= 0) return;
    if (kind === "stones") partner.timeStones = (partner.timeStones ?? 0) + half;
    else partner.tokens = (partner.tokens ?? 0) + half;
    room.landmarkMania.shareSeq = (room.landmarkMania.shareSeq ?? 0) + 1;
    room.landmarkMania.share = {
      seq: room.landmarkMania.shareSeq, from: seat, to: other, kind, amount: half, bid: b.bid
    };
  }

  // Use the location the car is parked at. Shared by the socket handler and
  // the AI; returns the building or null. Token-circle locations (time stone /
  // token / destress / discovery) take a token onto a free circle — once per
  // player per location — and pay the reward. Landmark locations are free and
  // unlimited (ride-pickup mode only). In landmark mode upgrade locations are
  // token-circle locations too, with one circle per player, and the reward is
  // the top of their upgrade stack. Either way it ends the turn's movement.
  function placeTokenCore(room, seat, truck, targetBid = null) {
    const ts = room.landmarkMania.turnState;
    if (ts.acted || room.landmarkMania.winner != null) return null;
    if (!truck || truck.spot == null) return null;
    const player = room.landmarkMania.players?.[seat];
    if (!player) return null;
    let b = buildingAtTruck(room, truck);
    if (!b) return null;
    if (targetBid != null && targetBid !== b.bid) {
      // Nearby parking: use any location in the block the car is parked at.
      if (!hasUp(player, "nearbyParking")) return null;
      const block = (room.landmarkMania.map.blocks ?? [])
        .find((bl) => (bl.buildings ?? []).some((x) => x.bid === b.bid));
      const target = (block?.buildings ?? []).find((x) => x.bid === targetBid);
      if (!target) return null;
      b = target;
    }
    if (b.role !== "loc") return null;

    if (b.locType === "landmark") {
      // Landmarks deal cards only in ride-pickup mode; otherwise they're pure
      // destinations — arriving already completed any matching cards.
      if (S(room).rideMode !== "ride-pickup") return null;
      dealRide(room, player, b);
    } else if (b.locType === "upgrade" && S(room).upgradeMode === "stack") {
      // Landmark mode: pay a token onto your own circle (every player has
      // one, so nobody can be shut out) and take the top of the stack — the
      // card underneath becomes the new face-up top. Only inside the
      // location's window: Morning, Afternoon, Evening or Night.
      if ((player.tokens ?? 0) < 1) return null;
      if (!Array.isArray(b.slots)) return null;
      if (b.slots.includes(seat)) return null; // one pull per player, ever
      if (!hasUp(player, "timeAgnostic") &&
          !landmarkWindowOpen(b.window, room.landmarkMania.time ?? START_TIME)) return null;
      const type = b.upgrade;
      if (!type) return null;
      const free = b.slots.indexOf(null);
      if (free === -1) return null;
      player.tokens -= 1;
      b.slots[free] = seat;
      (player.upgrades ??= []).push(type);
      const rest = (room.landmarkMania.upgradeStacks ??= {})[b.bid] ?? [];
      b.upgrade = rest.shift() ?? null;
      b.stackLeft = rest.length;
      // (Extra ride needs no help here: it raises the face-up cap, so a card
      // already waiting in the stack flips up when this turn ends.)
      noteColorClaim(room, seat, b.hood);
    } else if (b.locType === "upgrade") {
      // Free to use, no token. The player board caps the hand: two slots,
      // plus the neighbourhood-visit unlocks.
      const scheduled = S(room).upgradeMode === "scheduled";
      let type;
      if (scheduled) {
        // Scheduled mode: the location's own dealt upgrade, only during its
        // 4-hour window (time agnostics ignore the window), never respawned.
        type = b.upgrade;
        if (!type) return null;
        if (b.window != null && !hasUp(player, "timeAgnostic") &&
            windowOf(room.landmarkMania.time ?? START_TIME) !== b.window) return null;
      } else {
        // Spawn mode: only the one location currently holding the roaming
        // upgrade; the rest sit dead. Picking it up respawns the deck's next
        // draw at another upgrade location.
        if (room.landmarkMania.upgradeAt !== b.bid) return null;
        type = room.landmarkMania.upgradeType;
        if (!type) return null;
      }
      if ((player.upgrades ?? []).length >= upgradeCap(room, seat)) return null;
      (player.upgrades ??= []).push(type);
      // Extra ride kicks in immediately: the hand grows by one card.
      if (type === "extraRide" && S(room).rideMode !== "ride-pickup") {
        dealRide(room, player, b);
      }
      // Filling all four slots joins the champions' race (7 / 5 / 3 / 1).
      if (player.upgrades.length >= 4) {
        const champs = (room.landmarkMania.upgradeChampions ??= []);
        if (!champs.includes(seat)) champs.push(seat);
      }
      if (scheduled) {
        b.upgrade = null;
      } else {
        room.landmarkMania.upgradeType = drawUpgrade(room);
        room.landmarkMania.upgradeAt = room.landmarkMania.upgradeType
          ? pickUpgradeLocation(room, b.bid)
          : null;
      }
    } else {
      if ((player.tokens ?? 0) < 1) return null;
      if (!Array.isArray(b.slots)) return null;
      // Forced mode: a circle carries the names of who may stand on it —
      // one seat on a required location, two on a shared one.
      if (b.owner != null && b.owner !== seat) return null;
      if (Array.isArray(b.pair) && !b.pair.includes(seat)) return null;
      // One token per player per location — on top or beneath.
      if (b.slots.includes(seat) || (b.under ?? []).includes(seat)) return null;
      // Calming and rushing don't mix: no destress on a turn that kept going.
      if (b.locType === "destress" && ts.keptGoing) return null;
      // Timed locations: a location only opens during its time period —
      // unless the player is time agnostic.
      if (!hasUp(player, "timeAgnostic") && !locOpen(S(room), b, room.landmarkMania.time ?? START_TIME)) return null;
      const free = b.slots.indexOf(null);
      // Full circles: the undercut upgrade still takes the token — it slips
      // in beneath the ones on top (and never counts toward slot unlocks).
      const under = free === -1;
      if (under && !hasUp(player, "undercut")) return null;
      player.tokens -= 1;
      if (under) (b.under ??= []).push(seat);
      else b.slots[free] = seat;
      const settings = S(room);
      if (b.locType === "timestone") {
        player.timeStones += (settings.timeStoneReward ?? 4) + bonusStones(player);
        shareWithPair(room, b, seat, "stones");
      } else if (b.locType === "token") {
        player.tokens += (settings.tokenReward ?? 3) + bonusTokens(player);
        shareWithPair(room, b, seat, "tokens");
      } else if (b.locType === "required") {
        // Forced mode's required locations pay nothing whatsoever. Covering
        // one is the point — an empty circle of your color costs a point at
        // the end, and this is the only way to close it.
      } else if (b.locType === "discovery") {
        // The card source in every new mode: one landmark card, no say in
        // which, face down until the turn ends (and then only if there's room
        // for it face up).
        dealRide(room, player, b);
      } else if (b.locType === "star") {
        // Star mode: another star on the driver's rating, which is what every
        // future delivery pays.
        player.rating = Math.min(
          settings.ratingMax ?? RATING_MAX,
          (player.rating ?? 0) + STAR_STEP
        );
      } else if (b.locType === "destress") {
        // One gap down the bar — one more safe number, capped at the bottom.
        // (Sleeping is the full reset now.)
        player.stress = Math.min(STRESS_MAX, (player.stress ?? 2) + 1);
        ts.destressed = true; // destressing forces the turn to end — no keep going
      }
      // Landmark mode: this may be the third of a color — which claims it.
      if (!under) noteColorClaim(room, seat, b.hood);
    }
    ts.truck = truck.id;
    ts.acted = true;
    ts.undo = null; // the location is used — the move can't come back
    return b;
  }

  // Duplicate mode's other choice: complete the matching ride card(s) at the
  // location the car is parked at — instead of visiting it, never both. Every
  // face-up matching card completes at once and gets replaced; it counts as
  // the turn's action.
  function completeRideCore(room, seat, truck) {
    if (S(room).rideMode !== "duplicate") return null;
    const ts = room.landmarkMania.turnState;
    if (ts.acted || room.landmarkMania.winner != null) return null;
    if (!truck || truck.spot == null) return null;
    const player = room.landmarkMania.players?.[seat];
    if (!player) return null;
    const b = buildingAtTruck(room, truck);
    if (!b || b.role !== "loc") return null;
    const done = (player.rides ?? []).filter((r) => r.loc === b.bid && !r.faceDown).length;
    if (!done) return null;
    player.rides = player.rides.filter((r) => r.loc !== b.bid || r.faceDown);
    player.ridesCompleted = (player.ridesCompleted ?? 0) + done;
    // Forced mode refills at the END of the turn instead (topUpHand), so a
    // fresh card can't be delivered on the same turn it arrived.
    if (!isForced(room)) {
      for (let i = 0; i < done; i += 1) dealRide(room, player, b);
    }
    ts.truck = truck.id;
    ts.acted = true;
    ts.undo = null; // the completion commits everything before it
    return b;
  }

  // Forced mode's hand: always the same size, drawn back up at the end of the
  // turn and always face up. Nothing is ever buried, so nothing ever expires —
  // the only pressure on a card is that the days are running out.
  function topUpHand(room, player, from = null) {
    if (!isForced(room) || !player) return;
    const want = Math.max(1, S(room).forcedCards ?? FORCED_CARDS);
    let guard = 0;
    while ((player.rides ?? []).length < want && guard < want + 4) {
      const before = (player.rides ?? []).length;
      dealRide(room, player, from, false);
      guard += 1;
      if ((player.rides ?? []).length === before) break; // no destination left
    }
  }

  // Extra cash / extra time ride along with EVERY token / stone collection —
  // locations, welfare, neighbourhood bonuses, the fun die (but a zero-sized
  // collection stays zero).
  const bonusTokens = (player) => (hasUp(player, "extraCash") ? 1 : 0);
  const bonusStones = (player) => (hasUp(player, "extraTime") ? 2 : 0);

  // Sitting the turn out. The classic game has one option — welfare, a token
  // and some time stones, any hour. Landmark mode splits the clock: by DAY you
  // can nap (stress) or take WELFARE (2 tokens, no stones); by night you can
  // sleep (stress) or BEG (1 token). Nothing else skips a turn.
  //
  // `kind` is "welfare" or "beg"; returns false when it isn't on offer now.
  function payWelfare(room, player, kind = "welfare") {
    const settings = S(room);
    if (isNewMode(room)) {
      const night = isNight(room.landmarkMania.time ?? START_TIME);
      if (kind === "beg" ? !night : night) return false; // wrong half of the day
    } else if (kind === "beg") {
      return false; // begging belongs to the newer modes
    }
    const t = kind === "beg" ? (settings.begTokens ?? 1) : (settings.welfareTokens ?? 1);
    // Begging is a token and nothing else, and the newer modes' welfare pays
    // no stones either (modeCommon zeroes them) — EXCEPT in forced mode, where
    // both hand out stones. Nothing there ends the game but the hours running
    // out, and its only other stone supply is four split circles per player;
    // once those are gone a table with no stones could never move the clock
    // again, and simply sat there.
    const s = kind === "beg" ? (settings.begStones ?? 0) : (settings.welfareStones ?? 2);
    player.tokens = (player.tokens ?? 0) + t + (t > 0 ? bonusTokens(player) : 0);
    player.timeStones = (player.timeStones ?? 0) + s + (s > 0 ? bonusStones(player) : 0);
    return true;
  }

  // Sleep: only at night (7pm–6am), only in place of the whole turn — like
  // welfare, nothing moved and no location used. Stress drops all the way to
  // between 4 and 5 (super calm: between 5 and 6), and the sleeper may sweep
  // the clock forward up to 4 hours for free. Ends the turn.
  function sleepCore(room, seat, hours, nap = false) { // `hours` unused: resting no longer moves the clock
    const ts = room.landmarkMania.turnState;
    if (ts.truck != null || ts.acted || room.landmarkMania.winner != null) return false;
    const t = room.landmarkMania.time ?? START_TIME;
    // Sleeping is a night thing; napping is landmark mode's daytime version —
    // it costs the whole turn just the same but only walks the marker two
    // steps down the bar instead of resetting it.
    if (nap && (!isNewMode(room) || isNight(t))) return false;
    if (!nap && !isNight(t)) return false;
    const player = room.landmarkMania.players?.[seat];
    if (!player) return false;
    // Landmark mode rests deeper than the classic game: napping walks the
    // marker two steps down and sleeping takes it all the way, both capped at
    // the bottom of the bar — one step past it with super calm, where no die
    // can fine you.
    const cap = isNewMode(room) ? restCap(player) : STRESS_MAX;
    player.stress = nap
      ? Math.min(cap, (player.stress ?? 2) + NAP_STEPS)
      : isNewMode(room)
      ? Math.max(player.stress ?? 2, cap)
      : Math.max(player.stress ?? 2, hasUp(player, "superCalm") ? 5 : DESTRESS_TO);
    // Resting buys stress relief and nothing else — it does NOT sweep the
    // clock. Hours are ignored (the parameter stays for old clients).
    ts.skipped = true;
    return true;
  }

  // End-of-turn beat: roll the banked dice against the roller's stress marker
  // (between `stress` and `stress+1`) — every die over it costs tokens.
  // Returns how long clients will animate the roll (0 when nothing rolled).
  function rollStressDice(room, playerIdx) {
    const player = room.landmarkMania.players?.[playerIdx];
    const ts = room.landmarkMania.turnState;
    const n = Math.max(0, Math.min(12, ts?.dicePool ?? 0));
    if (player && n > 0) {
      const stress = player.stress ?? 2;
      const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
      const fails = dice.filter((d) => d > stress).length;
      const owed = fails * (S(room).tokensPerFail ?? 1);
      const loss = Math.min(player.tokens ?? 0, owed);
      player.tokens = Math.max(0, (player.tokens ?? 0) - owed);
      player.redTokensLost = (player.redTokensLost ?? 0) + loss; // the end-game swing tracks this
      // A fine you can't cover still gets paid, just not in tokens: landmark
      // mode bills points, simple mode takes half a star per token short.
      const short = owed - loss;
      if (isForced(room) && short > 0) {
        // Forced mode: a fine you have no tokens for costs no tokens. It
        // counts DOUBLE on the fine tally instead — which is the only thing
        // fines are ever read off, at the end and in the tiebreak.
        player.redTokensLost = (player.redTokensLost ?? 0) + short * FORCED_SHORT_FINES;
      } else if (isSimple(room) && short > 0) {
        const lost = Math.min(player.rating ?? 0, short * SIMPLE_SHORT_STARS);
        player.rating = Math.max(0, (player.rating ?? 0) - lost);
        player.starsLost = (player.starsLost ?? 0) + lost;
      } else if (isLandmark(room) && short > 0) {
        player.shortPenalties = (player.shortPenalties ?? 0) + short * (S(room).shortPenalty ?? 1);
      }
      room.landmarkMania.rollSeq = (room.landmarkMania.rollSeq || 0) + 1;
      room.landmarkMania.lastRoll = {
        seq: room.landmarkMania.rollSeq, player: playerIdx, dice,
        aversion: stress, // the safe-roll threshold, named as the client's dice code expects
        tickets: fails,   // failed dice (drives the shared dice animation)
        loss,             // tokens actually paid
        short,            // tokens short — paid in points in landmark mode
        mode: "tokens"
      };
      return diceMsFor(room.landmarkMania.lastRoll);
    }
    room.landmarkMania.lastRoll = null;
    return 0;
  }

  // A sensible pick when the holder didn't choose (the AI, or a stale client).
  function defaultHoodChoice(player) {
    if ((player.stress ?? 2) <= 2) return "destress";
    if ((player.timeStones ?? 0) <= 3) return "stones";
    return "token";
  }

  // Hood upgrades pay out when their holder ends a turn parked at a location
  // of that neighbourhood — before the stress dice roll, so a destress step
  // arrives in time to matter for it. The reward is the holder's choice each
  // time (`choices` comes with the end-turn, one entry per matching upgrade):
  // 1 token, 1 destress step, or 2 time stones.
  function grantHoodBonuses(room, seat, choices = []) {
    const player = room.landmarkMania.players?.[seat];
    const truck = (room.landmarkMania.trucks ?? []).find((t) => t.player === seat);
    if (!player || !truck || truck.spot == null) return;
    const b = buildingAtTruck(room, truck);
    if (!b || b.hood == null) return;
    let i = 0;
    for (const type of player.upgrades ?? []) {
      const hu = parseHoodUpgrade(type);
      if (!hu || hu.hood !== b.hood) continue;
      const pick = HOOD_REWARDS.includes(choices[i]) ? choices[i] : defaultHoodChoice(player);
      i += 1;
      if (pick === "token") {
        player.tokens = (player.tokens ?? 0) + 1 + bonusTokens(player);
      } else if (pick === "stones") {
        player.timeStones = (player.timeStones ?? 0) + 2 + bonusStones(player);
      } else {
        // One step down the bar — one more safe number, capped at the bottom.
        player.stress = Math.min(STRESS_MAX, (player.stress ?? 2) + 1);
      }
    }
  }

  // The fun die: a turn that banked no stress dice (crossed no reds) and
  // wasn't sat out ends on this instead — 1/3 each: a destress step, 1 token,
  // or 2 time stones (the extra cash / time upgrades ride along).
  function rollFunDie(room, seat) {
    const player = room.landmarkMania.players?.[seat];
    if (!player) return 0;
    const face = HOOD_REWARDS[Math.floor(Math.random() * HOOD_REWARDS.length)];
    if (face === "token") {
      player.tokens = (player.tokens ?? 0) + 1 + bonusTokens(player);
    } else if (face === "stones") {
      player.timeStones = (player.timeStones ?? 0) + 2 + bonusStones(player);
    } else {
      // The fun die's destress step obeys the same cap as sleeping and
      // napping: the bottom of the bar, one past it with super calm.
      const cap = isNewMode(room) ? restCap(player) : STRESS_MAX;
      player.stress = Math.min(cap, (player.stress ?? 2) + 1);
    }
    room.landmarkMania.funSeq = (room.landmarkMania.funSeq || 0) + 1;
    room.landmarkMania.funRoll = { seq: room.landmarkMania.funSeq, player: seat, face };
    return FUN_DIE_MS;
  }

  // The shared end-of-turn path (humans and AI): pay the neighbourhood
  // bonuses, roll the banked dice (or the fun die when none banked), then
  // either score the game (the days have run out) or pass the turn.
  function endTurnCore(roomId, seat, hoodChoices = []) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "landmark-mania") return;
    grantHoodBonuses(room, seat, hoodChoices);
    const ts = room.landmarkMania.turnState;
    room.landmarkMania.funRoll = null;
    let rollMs;
    if ((ts?.dicePool ?? 0) === 0 && !ts?.skipped) {
      room.landmarkMania.lastRoll = null;
      rollMs = rollFunDie(room, seat);
    } else {
      rollMs = rollStressDice(room, seat);
    }
    // Turn over, dice rolled and all: only now do face-down cards flip up —
    // and in landmark mode only as far as the two-card window allows.
    flipRides(room, room.landmarkMania.players?.[seat]);
    // Forced mode has no stack to flip — it draws back up to a full hand
    // instead, steering clear of wherever the car is parked.
    {
      const truck = (room.landmarkMania.trucks ?? []).find((t) => t.player === seat);
      topUpHand(room, room.landmarkMania.players?.[seat],
        truck && truck.spot != null ? buildingAtTruck(room, truck) : null);
    }
    // And only now does any dawn this turn rolled past actually land: the
    // neighbourhood scoring, the late-card charge and the board wipe. Whoever
    // pushed the clock over got their whole turn first.
    settleDawn(room);
    const endHours = (S(room).days ?? 3) * 24;
    if ((room.landmarkMania.elapsed ?? 0) >= endHours) {
      finalizeGame(room);
      clearAiTimer(roomId);
      emitState(roomId, room);
      return;
    }
    advanceTurn(roomId, rollMs);
  }

  // ---- Turn order + the AI driver -----------------------------------------
  // Same shape as Truck Mania's: an AI turn plays in beats the humans can
  // watch — clock flip, drive, act — each delayed past the client animations
  // it triggers, all scaled by the room's speed dial.

  const CAR_SPEED = 200; // px per second — keep in sync with the client
  const DICE_MS_LOSS = 3700; // roll that cost tokens: tumble + "−N" beat
  const DICE_MS_SAFE = 2500; // roll with no fails
  const FUN_DIE_MS = 2200;   // the fun-die banner beat
  const CLOCK_MS = 3600; // staged time change: hand sweep + two slow flips
  const AI_TURN_GAP_MS = 1000;
  const TOKEN_VALUE = 0.3; // rough end-game-points worth of one token

  const diceMsFor = (roll) => (roll ? (roll.tickets > 0 ? DICE_MS_LOSS : DICE_MS_SAFE) : 0);

  const aiTimers = new Map(); // roomId -> pending setTimeout handle

  function clearAiTimer(roomId) {
    const t = aiTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      aiTimers.delete(roomId);
    }
  }

  // Hand the turn on, resetting the per-turn flags; schedule the AI when the
  // next seat is one. `extraMs` waits out whatever the last turn left animating.
  function advanceTurn(roomId, extraMs = 0) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "landmark-mania") return;
    if (room.landmarkMania.winner != null) {
      emitState(roomId, room);
      return;
    }
    const n = room.landmarkMania.players?.length ?? 1;
    room.landmarkMania.turn = ((room.landmarkMania.turn ?? 0) + 1) % n;
    room.landmarkMania.turnState = freshTurnState();
    room.landmarkMania.aiMove = null;
    emitState(roomId, room);
    if (room.landmarkMania.players[room.landmarkMania.turn]?.isAI) {
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => runAiTurn(roomId), (AI_TURN_GAP_MS + extraMs) / roomSpeed(room)));
    }
  }

  function getAiGraph(room) {
    const map = room.landmarkMania.map;
    const cache = room.landmarkMania.aiGraph;
    if (cache && cache.seed === map.seed) return cache.graph;
    const graph = buildStreetGraph(map.streets, map.spots ?? []);
    room.landmarkMania.aiGraph = { seed: map.seed, graph };
    return graph;
  }

  // Stones the AI will spend on one clock flip. A flip costs however far round
  // the face the light's number sits — near enough uniform over 1..11 — so a
  // low ceiling here silently refuses most of them: at the old `stones * 0.6`
  // a six-stone AI would only ever consider a cost of 4 or less, i.e. two
  // flips in three were rejected out of hand, and tables sat on the same hour
  // for whole games with a dozen stones in pocket.
  //
  // Stones score NOTHING at the end of any mode, so hoarding them is pure
  // waste — the AI spends down to a small reserve, and once the last day is
  // running it spends the lot.
  const AI_STONE_RESERVE = 2;
  function aiTimeBudget(room, player) {
    const s = player.timeStones ?? 0;
    if (s <= 0) return 0;
    const lastDay = (room.landmarkMania.elapsed ?? 0) >= ((S(room).days ?? 3) - 1) * 24;
    return Math.min(11, lastDay ? s : Math.max(4, s - AI_STONE_RESERVE));
  }

  // Reds crossed by a path, by number, so the AI knows which flips would help.
  function redsAlong(path, intersections, endpoints) {
    const REACH = 13;
    const nums = [];
    const greens = [];
    let count = 0;
    for (const o of intersections) {
      if (endpoints.some(([x, y]) => Math.hypot(o.x - x, o.y - y) < REACH)) continue;
      let onPath = false;
      for (let i = 0; i < path.length - 1 && !onPath; i += 1) {
        const dx = path[i + 1][0] - path[i][0];
        const dy = path[i + 1][1] - path[i][1];
        const lenSq = dx * dx + dy * dy;
        let t = lenSq ? ((o.x - path[i][0]) * dx + (o.y - path[i][1]) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const px = path[i][0] + t * dx;
        const py = path[i][1] + t * dy;
        if (Math.hypot(o.x - px, o.y - py) < REACH) onPath = true;
      }
      if (!onPath) continue;
      if (o.color === "red") {
        count += 1;
        if (o.number != null) nums.push(o.number);
      } else if (o.number != null) {
        greens.push(o.number);
      }
    }
    return { count, nums, greens };
  }

  // Clock change that nets the AI fewer reds on its path, within its stone
  // budget. The hand only sweeps clockwise here (no abilities in this game),
  // and the sweep burns game hours like any human change would.
  function maybeAiChangeTime(room, player, numbers, greens = []) {
    const ts = room.landmarkMania.turnState;
    if (ts.changedTime) return false; // once per turn
    const budget = aiTimeBudget(room, player);
    if (!numbers.length || budget <= 0) return false;
    const redCount = {};
    numbers.forEach((n) => { redCount[n] = (redCount[n] || 0) + 1; });
    const greenCount = {};
    greens.forEach((n) => { greenCount[n] = (greenCount[n] || 0) + 1; });
    const t = room.landmarkMania.time ?? START_TIME;
    const curPos = t % 12;
    let best = null;
    for (const num of Object.keys(redCount).map(Number)) {
      const gain = redCount[num] - (greenCount[num] || 0);
      if (gain <= 0) continue; // flipping would just trade reds around
      const cost = (num % 12 - curPos + 12) % 12;
      if (cost >= 1 && cost <= budget && cost <= player.timeStones) {
        if (!best || gain > best.gain || (gain === best.gain && cost < best.cost)) {
          best = { num, cost, gain };
        }
      }
    }
    if (!best) return false;
    player.timeStones -= best.cost;
    runClock(room, best.cost);
    for (const oct of room.landmarkMania.map.intersections) {
      if (oct.number === best.num) oct.color = oct.color === "green" ? "red" : "green";
    }
    ts.changedTime = true;
    return true;
  }

  function pathLen(path) {
    let len = 0;
    for (let i = 1; i < path.length; i += 1) {
      len += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    }
    return len;
  }

  // Where an off-board car may enter: the stoplights on the border streets.
  const EDGE_PAD = 20;
  function edgeLights(map) {
    const w = map.width ?? 960;
    const h = map.height ?? 720;
    const all = map.intersections ?? [];
    const edge = all.filter((o) =>
      o.x < EDGE_PAD || o.x > w - EDGE_PAD || o.y < EDGE_PAD || o.y > h - EDGE_PAD);
    return edge.length ? edge : all;
  }

  function inwardDir(map, o) {
    const w = map.width ?? 960;
    const h = map.height ?? 720;
    let dx = 0;
    let dy = 0;
    if (o.x < EDGE_PAD) dx = 1;
    else if (o.x > w - EDGE_PAD) dx = -1;
    if (o.y < EDGE_PAD) dy = 1;
    else if (o.y > h - EDGE_PAD) dy = -1;
    if (!dx && !dy) {
      dx = w / 2 - o.x;
      dy = h / 2 - o.y;
    }
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }

  // Drive an off-board car onto the board through an entry light near the
  // destination; the entry light counts like any other (red = a die).
  function aiEnterCar(room, truck, player, destSpotIdx) {
    const map = room.landmarkMania.map;
    const dest = (map.spots ?? [])[destSpotIdx];
    if (!dest) return false;
    const graph = getAiGraph(room);
    const lights = [...edgeLights(map)].sort((a, b) =>
      Math.hypot(a.x - dest.x, a.y - dest.y) - Math.hypot(b.x - dest.x, b.y - dest.y));
    let best = null;
    for (const light of lights.slice(0, 4)) {
      const [ix, iy] = inwardDir(map, light);
      const inward = (Math.atan2(iy, ix) * 180) / Math.PI;
      for (const heading of [inward, inward - 90, inward + 90]) {
        const route = findRouteDirected(
          graph, map.intersections, light.x, light.y, heading, dest.x, dest.y, false
        );
        if (!route) continue;
        const reds = route.reds + (light.color === "red" ? 1 : 0);
        const len = pathLen(route.path);
        if (!best || reds < best.reds || (reds === best.reds && len < best.len)) {
          best = { light, ix, iy, route, reds, len };
        }
      }
    }
    if (!best) return false;
    const path = [
      [best.light.x - best.ix * 46, best.light.y - best.iy * 46],
      ...best.route.path
    ];
    truck.facing = best.route.endAngle;
    applyMove(room, truck, destSpotIdx, best.reds);
    room.landmarkMania.aiMove = { truckId: truck.id, path, endAngle: best.route.endAngle };
    room.landmarkMania.driveMs = Math.max(450, (pathLen(path) / CAR_SPEED) * 1000) + 300;
    return true;
  }

  // Drive the AI's car to a spot, greening a red on the way when affordable.
  function aiDriveCarTo(room, truck, player, destSpotIdx) {
    if (truck.spot == null) return aiEnterCar(room, truck, player, destSpotIdx);
    const map = room.landmarkMania.map;
    const spots = map.spots ?? [];
    const here = spots[truck.spot];
    const dest = spots[destSpotIdx];
    if (!here || !dest || destSpotIdx === truck.spot) return false;
    const graph = getAiGraph(room);
    const heading = truck.facing ?? here.angle;

    const uturn = hasUp(player, "uturn");
    let route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y, uturn);
    if (route && route.reds > 0) {
      const rd = redsAlong(route.path, map.intersections, [[here.x, here.y], [dest.x, dest.y]]);
      if (rd.count > 0 && maybeAiChangeTime(room, player, rd.nums, rd.greens)) {
        room.landmarkMania.clockMs = CLOCK_MS;
        route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y, uturn) || route;
      }
    }

    let path;
    let endAngle;
    let redCount;
    if (route) {
      ({ path, endAngle } = route);
      redCount = route.reds;
    } else {
      path = findPath(graph, here.x, here.y, dest.x, dest.y);
      if (!path) return false;
      redCount = redsAlong(path, map.intersections, [[here.x, here.y], [dest.x, dest.y]]).count;
      endAngle = 0;
      for (let i = path.length - 1; i > 0; i -= 1) {
        const dx = path[i][0] - path[i - 1][0];
        const dy = path[i][1] - path[i - 1][1];
        if (Math.hypot(dx, dy) > 0.01) {
          endAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
          break;
        }
      }
    }

    truck.facing = endAngle;
    applyMove(room, truck, destSpotIdx, redCount);
    room.landmarkMania.aiMove = { truckId: truck.id, path, endAngle };
    room.landmarkMania.driveMs = Math.max(450, (pathLen(path) / CAR_SPEED) * 1000) + 300;
    return true;
  }

  // ---- AI valuation ---------------------------------------------------------

  // Worth of using this location right now, in rough end-game points. Token
  // circles: the reward plus slot-unlock progress, minus the token spent.
  // Uber pickups are free — worth a discounted future ride, cooled off by
  // however many undone cards the AI is already holding.
  function aiPlaceValue(room, seat, player, b) {
    if (!b || b.role !== "loc") return 0;
    const settings = S(room);
    if (b.locType === "landmark") {
      if (settings.rideMode !== "ride-pickup") return 0; // destinations only
      const open = player.rides?.length ?? 0;
      return (0.55 * (settings.ridePoints ?? 2)) / (1 + open);
    }
    if (b.locType === "upgrade" && settings.upgradeMode === "stack") {
      // Landmark mode: a token buys the top of the stack, once per player, and
      // only inside the location's window. Every upgrade is a flat point.
      if ((player.tokens ?? 0) < 1) return 0;
      if (!Array.isArray(b.slots) || b.slots.includes(seat) || !b.slots.includes(null)) return 0;
      if (!b.upgrade) return 0;
      if (!hasUp(player, "timeAgnostic") &&
          !landmarkWindowOpen(b.window, room.landmarkMania.time ?? START_TIME)) return 0;
      let v = -TOKEN_VALUE + (settings.upgradePoints ?? 1) * 0.9;
      if (!hasUp(player, b.upgrade)) v += 0.7; // a perk it doesn't have yet
      v += colorClaimValue(room, seat, settings, b.hood);
      return v;
    }
    if (b.locType === "upgrade") {
      // Free action for a real perk — but a type the AI already holds is
      // nearly worthless, dead spots are worth nothing, and a full player
      // board can't take one at all. Scheduled mode: the location's own
      // upgrade, only while its 4-hour window is open.
      const type = settings.upgradeMode === "scheduled"
        ? (b.window == null || hasUp(player, "timeAgnostic") ||
           windowOf(room.landmarkMania.time ?? START_TIME) === b.window ? b.upgrade : null)
        : (room.landmarkMania.upgradeAt === b.bid ? room.landmarkMania.upgradeType : null);
      if (!type) return 0;
      const held = (player.upgrades ?? []).length;
      if (held >= upgradeCap(room, seat)) return 0;
      if (hasUp(player, type)) return 0.15;
      // The fourth pickup banks the champions' race points (7 / 5 / 3 / 1).
      const racePts = held === 3
        ? Math.max(1, 7 - 2 * (room.landmarkMania.upgradeChampions ?? []).length)
        : 0;
      return 1.1 + racePts * 0.5;
    }
    if (!Array.isArray(b.slots)) return 0;
    if ((player.tokens ?? 0) < 1) return 0;
    // Forced mode: circles carry names — a location this seat isn't on is
    // worth nothing to it, ever.
    if (b.owner != null && b.owner !== seat) return 0;
    if (Array.isArray(b.pair) && !b.pair.includes(seat)) return 0;
    if (b.slots.includes(seat) || (b.under ?? []).includes(seat)) return 0;
    // A full location only takes an undercut token (no unlock progress).
    const under = !b.slots.includes(null);
    if (under && !hasUp(player, "undercut")) return 0;
    // Timed locations: closed outside its time period (the AI doesn't plan
    // clock flips around visits — it just reads the clock as it stands).
    // Time-agnostic players ignore the gate.
    if (!hasUp(player, "timeAgnostic") && !locOpen(settings, b, room.landmarkMania.time ?? START_TIME)) return 0;
    let v = -TOKEN_VALUE; // the token played
    if (b.locType === "required") {
      // Forced mode: this pays nothing. What it's worth is the point it stops
      // you losing — and that point gets dearer as the days run out, because
      // an uncovered circle late in the game is very nearly a certain loss
      // while an early one is a job you still have time to get to.
      const progress = Math.min(1,
        (room.landmarkMania.elapsed ?? 0) / Math.max(1, (settings.days ?? 3) * 24));
      v += (settings.forcedMissPenalty ?? 1) * (0.9 + 0.6 * progress);
    } else if (b.locType === "timestone") {
      v += (player.timeStones < 4 ? 0.22 : 0.13) * (settings.timeStoneReward ?? 4);
      v -= pairGiftCost(room, b, seat, "stones");
    } else if (b.locType === "destress") {
      // Calming is off the table on a turn that rushed (kept going).
      if (room.landmarkMania.turnState?.keptGoing) return 0;
      // One step down the bar — worth more the higher the marker sits.
      const stress = player.stress ?? 2;
      v += stress >= STRESS_MAX ? 0.02 : 0.5 + 0.15 * (DESTRESS_TO - stress);
    } else if (b.locType === "token") {
      v += TOKEN_VALUE * (settings.tokenReward ?? 3);
      v -= pairGiftCost(room, b, seat, "tokens");
    } else if (b.locType === "discovery") {
      // A card is worth points once driven — but an undelivered one costs:
      // landmark mode bills every night it sits face down, star mode docks
      // half a star at dawn for any card still in hand, and simple mode's
      // clean-hand star is only whole when the hand is empty.
      const open = (player.rides ?? []).filter((r) => !r.faceDown).length;
      const buried = (player.rides ?? []).filter((r) => r.faceDown).length;
      v += (0.75 * cardPoints(room, settings, player) + 0.35) / (1 + open * 0.6);
      // Roughly how many more dawns this card could be caught by.
      const nightsLeft = Math.max(0,
        (settings.days ?? 3) - Math.floor((room.landmarkMania.elapsed ?? 0) / 24));
      if (isSimple(room)) {
        // A card that can't even flip up expires at dawn — the card itself is
        // the loss, and it takes the whole clean-hand star with it. One that
        // does flip only risks the half, and only if it's still undelivered
        // when the day ends, so it's discounted far more gently.
        const wouldBury = open + buried >= visibleRideCap(room, player);
        if (wouldBury) {
          v -= 0.75 * cardPoints(room, settings, player) * 0.6;
          v -= SIMPLE_STAR_STEP * simpleStarValue(room, player) * 0.3;
        } else {
          v -= SIMPLE_HALF_STEP * simpleStarValue(room, player) * 0.12;
        }
      } else if (isStar(room)) {
        // Every card in hand at dawn shaves half a star off every future
        // delivery — the more it's already carrying, the worse another is.
        v -= LATE_STEP * Math.min(2, nightsLeft) * (1 + open + buried) * 0.5;
      } else {
        const wouldBury = open + buried >= visibleRideCap(room, player);
        if (wouldBury) v -= (settings.cardPenalty ?? 1) * Math.min(2, nightsLeft) * 0.8;
      }
    } else if (b.locType === "star") {
      // Star mode: a star raises what every remaining delivery pays. Worth
      // more the earlier it lands and the more cards are still to come.
      const daysLeft = Math.max(0,
        (settings.days ?? 3) - (room.landmarkMania.elapsed ?? 0) / 24);
      if ((player.rating ?? 0) >= (settings.ratingMax ?? RATING_MAX)) v += 0.05;
      else v += 0.9 + 0.6 * Math.min(2, daysLeft);
    }
    if (!under && b.hood != null) {
      if (isLandmark(room)) {
        // Landmark mode: hoods are scoring colors — the third of a color is
        // where the points are.
        v += colorClaimValue(room, seat, settings, b.hood);
      } else if (isStar(room) || isSimple(room)) {
        // Star and simple modes: only the number of DIFFERENT neighbourhoods
        // you're standing in matters, and it's paid out (and wiped) at dawn.
        v += hoodSpreadValue(room, seat, settings, b.hood);
      } else {
        // Classic: visits unlock upgrade slots — fresh hoods matter most.
        const c = hoodVisits(room, seat, b.hood);
        v += c === 0 ? 0.5 : c === 1 ? 0.25 : 0;
      }
    }
    return v;
  }

  // Forced mode: what using a split circle hands the OTHER name on it. Half
  // the reward goes to a live opponent whether you like it or not, so the trip
  // is worth a little less than the sticker price — but only a little. Never
  // enough to make an AI refuse the shopping altogether: a mode where nobody
  // ever collects anything is a mode where nobody can afford to drive.
  function pairGiftCost(room, b, seat, kind) {
    if (!Array.isArray(b.pair)) return 0;
    const other = b.pair.find((s) => s !== seat);
    if (other == null || !room.landmarkMania.players?.[other]) return 0;
    const s = S(room);
    const half = Math.floor(
      (kind === "stones" ? (s.timeStoneReward ?? 6) : (s.tokenReward ?? 4)) / 2);
    return (kind === "stones" ? 0.05 : TOKEN_VALUE * 0.3) * half;
  }

  // Star mode: what reaching into one more neighbourhood is worth today. A
  // hood the AI already stands in adds nothing — the spread counts distinct
  // ones — so this is the step up the payout table, discounted a little
  // because dawn might arrive before it can finish the job.
  function hoodSpreadValue(room, seat, settings, hood) {
    if (hood == null || !(isStar(room) || isSimple(room))) return 0;
    const have = new Set();
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role === "loc" && b.hood != null && Array.isArray(b.slots) && b.slots.includes(seat)) {
          have.add(b.hood);
        }
      }
    }
    if (have.has(hood)) return 0; // already covered today
    const n = have.size;
    if (isSimple(room)) {
      // Simple mode's spread only pays at the very top — a whole star for all
      // five neighbourhoods, a half for four — so scoring each visit by what
      // it pays TODAY makes the first three look worthless and the AI never
      // leaves the kerb. Value them as what they are instead: equal steps
      // toward the star still on the table, so the pull grows as the set
      // closes.
      const total = (room.landmarkMania.hoods ?? []).length || SIMPLE_HOOD_COUNT;
      if (n >= total) return 0;
      const nowGain = total > 1 && n >= total - 1 ? SIMPLE_HALF_STEP : 0;
      const share = (SIMPLE_STAR_STEP - nowGain) / (total - n);
      return share * simpleStarValue(room, room.landmarkMania.players?.[seat]) * 0.75;
    }
    const table = settings.hoodSpread ?? HOOD_SPREAD_SCORE;
    const now = table[Math.min(n, table.length - 1)] ?? 0;
    const next = table[Math.min(n + 1, table.length - 1)] ?? 0;
    return Math.max(0, next - now) * 0.75;
  }

  // Simple mode: what one more star is worth to the AI in end-game points.
  // The final score is landmarks × stars, so a star pays a point for every
  // card the driver ends up having delivered — what it has already plus a
  // rough allowance for the days still to come.
  function simpleStarValue(room, player) {
    const done = player?.ridesCompleted ?? 0;
    const daysLeft = Math.max(0,
      (S(room).days ?? 3) - (room.landmarkMania.elapsed ?? 0) / 24);
    return done + daysLeft * 2;
  }

  // What another token of this color is worth to the AI: the claim points if
  // this one seals it, a growing pull as it closes in, nothing once the color
  // is already claimed twice or by this player.
  function colorClaimValue(room, seat, settings, color) {
    if (!isLandmark(room) || color == null) return 0;
    const list = room.landmarkMania.colorClaims?.[color] ?? [];
    if (list.includes(seat)) return 0;      // already banked
    if (list.length >= 2) return 0;         // both places gone
    const pts = list.length === 0
      ? (settings.colorFirstPoints ?? 2)
      : (settings.colorSecondPoints ?? 1);
    const have = colorProgress(room, seat, color);
    const need = colorTarget(room, color) - have;
    if (need <= 1) return pts * 0.9;        // this token claims it
    if (need === 2) return pts * 0.35;
    return pts * 0.12;
  }

  // What completing one card is worth to the AI. Star mode pays the driver's
  // rating; landmark mode pays less per card than the classic game does per
  // ride, but its "most cards" bonus rides on top, so the two land close.
  const cardPoints = (room, settings, player) => {
    // Forced mode: a flat point, no bonus riding on it.
    if (isForced(room)) return settings.forcedCardPoints ?? 1;
    // Star mode: a delivery pays the driver's rating, rounded down.
    if (isStar(room)) return Math.floor(player?.rating ?? RATING_START);
    // Simple mode: the score is landmarks × stars, so one more card is worth
    // whatever the rating FINISHES at — not what it is now. Project the days
    // left at roughly a star apiece, capped at the meter.
    if (isSimple(room)) {
      const daysLeft = Math.max(0,
        (settings.days ?? 3) - (room.landmarkMania.elapsed ?? 0) / 24);
      return Math.min(settings.ratingMax ?? SIMPLE_STAR_MAX,
        (player?.rating ?? SIMPLE_START_STARS) + daysLeft * 0.75);
    }
    if (isLandmark(room)) {
      return (settings.landmarkPoints ?? 1) + (settings.mostLandmarksBonus ?? 2) * 0.25;
    }
    return settings.ridePoints ?? 2;
  };

  // Expected token cost of crossing `reds` red lights at this stress level.
  function aiRedRisk(room, player, reds) {
    if (!reds) return 0;
    const stress = player.stress ?? 2;
    const pFail = (6 - Math.max(1, Math.min(5, stress))) / 6;
    const owed = reds * pFail * (S(room).tokensPerFail ?? 1);
    // (Simple mode pays a fine it can't cover in STARS rather than tokens,
    // which is much dearer — but pricing that in here priced the AI off the
    // road entirely: it stopped crossing reds, which is also what moves the
    // clock, and the days stopped turning over. Left out deliberately.)
    return owed * TOKEN_VALUE + reds * 0.05;
  }

  // Every worthwhile destination for the AI's car: places it could place a
  // token, and the destinations of its open ride cards (arrival completes
  // them). Each is { spot, d, value }.
  function aiCandidates(room, seat, truck, player) {
    const map = room.landmarkMania.map;
    const spots = map.spots ?? [];
    const here = truck.spot != null ? spots[truck.spot] : null;
    const entries = here ? null : edgeLights(map);
    const distTo = (s) => (here
      ? Math.hypot(s.x - here.x, s.y - here.y)
      : Math.min(...entries.map((o) => Math.hypot(s.x - o.x, s.y - o.y))));
    const occupied = new Set(
      (room.landmarkMania.trucks ?? []).filter((t) => t.id !== truck.id).map((t) => t.spot));
    const settings = S(room);
    const out = [];
    spots.forEach((s, i) => {
      if (i !== truck.spot && occupied.has(i)) return;
      const b = buildingByBid(map, s.building);
      if (!b || b.role !== "loc") return;
      let value = aiPlaceValue(room, seat, player, b);
      // Ride value: face-down cards are inert (and unseen) until the turn
      // ends. Outside duplicate mode rides complete on arrival — but only by
      // driving there, so staying put doesn't count. In duplicate mode
      // completing is an action that replaces visiting (one or the other, and
      // parked counts), so the location is worth the better of the two.
      const matching = (player.rides ?? []).filter((r) => r.loc === b.bid && !r.faceDown).length;
      const rideValue = matching * cardPoints(room, settings, player) * 0.95;
      if (settings.rideMode === "duplicate") {
        if (matching > 0) value = Math.max(value, rideValue);
      } else if (i !== truck.spot && matching > 0) {
        value += rideValue;
      }
      if (value <= 0.05) return;
      out.push({ spot: i, d: distTo(s), value });
    });
    return out;
  }

  // Beat one of an AI turn: rank the candidates, re-score the leaders against
  // the real route's red lights, and drive the winner there (or stay put when
  // the best spot is the one it's parked on). Falls back to welfare when
  // nothing on the board is worth the trip.
  function aiMovePhase(room, idx) {
    const player = room.landmarkMania.players?.[idx];
    const truck = (room.landmarkMania.trucks ?? []).find((t) => t.player === idx);
    if (!player || !truck) return false;
    const map = room.landmarkMania.map;
    const spots = map.spots ?? [];
    const graph = getAiGraph(room);
    const ts = room.landmarkMania.turnState;

    // Rank every worthwhile stop against the board as it stands right now.
    // Called again after a clock change, since that reopens half the board.
    const pickBest = () => {
      const cands = aiCandidates(room, idx, truck, player)
        .sort((a, b) => (b.value - b.d * 0.0005) - (a.value - a.d * 0.0005));
      let top = null;
      for (const c of cands.slice(0, 6)) {
        let score;
        if (c.spot === truck.spot) {
          score = c.value; // already parked there
        } else if (truck.spot == null) {
          score = c.value - aiRedRisk(room, player, 1) - c.d * 0.0005;
        } else {
          const here = spots[truck.spot];
          const dest = spots[c.spot];
          const route = findRouteDirected(
            graph, map.intersections, here.x, here.y,
            truck.facing ?? here.angle, dest.x, dest.y, hasUp(player, "uturn")
          );
          const reds = route ? route.reds : 2;
          score = c.value - aiRedRisk(room, player, reds) - c.d * 0.0005;
        }
        if (!top || score > top.score) top = { ...c, score };
      }
      return top;
    };
    let best = pickBest();

    // Resting or a handout beats a bad board — but not on a keep-going
    // continuation (the turn already acted; there's no skip left to take), and
    // NEVER while the car is still off the board. A car in the garage scores
    // every candidate worse (it pays an entry red and a long first leg), so
    // without this guard an AI could find every turn "not worth it", rest, and
    // sit in the garage for the whole game — which is exactly what happened.
    const offBoard = truck.spot == null;
    if (!ts.keptGoing && !(offBoard && best)) {
      const settings = S(room);
      const night = isNight(room.landmarkMania.time ?? START_TIME);
      const kind = isNewMode(room) && night ? "beg" : "welfare";
      const handoutTokens = kind === "beg"
        ? (settings.begTokens ?? 1)
        : (settings.welfareTokens ?? 1);
      const handoutStones = kind === "beg" ? 0 : (settings.welfareStones ?? 2);
      const welfare = TOKEN_VALUE * handoutTokens + 0.1 * handoutStones;
      const poor = !best || best.score < Math.max(welfare, 0.9);

      // Nothing on this half of the clock is worth the trip? Then buy the
      // other half. Since resting stopped sweeping the clock, PAYING is the
      // only way time moves — and the game only ends once the days have
      // elapsed, so an AI table that never bought hours would sit on one hour
      // forever. Re-rank afterwards: the board it just opened is the one it
      // should be driving into.
      if (poor && aiBuyTime(room, idx, player)) {
        best = pickBest();
        if (best && best.spot !== truck.spot) {
          return aiDriveCarTo(room, truck, player, best.spot);
        }
        return false; // clock bought; act in place or sit this one out
      }

      // Resting no longer moves the clock, so it is worth a turn only when it
      // actually buys stress relief — at the bottom of the bar it does
      // nothing at all, and taking it anyway is how a turn gets thrown away.
      const cap = isNewMode(room) ? restCap(player) : STRESS_MAX;
      const canRest = (player.stress ?? 2) < cap && (player.stress ?? 2) <= 2;
      if (canRest && (!best || best.score < (night ? 1.2 : 0.9))) {
        // Sleeping is the night option, napping the day one (new modes only).
        if (night) {
          if (sleepCore(room, idx, 0)) return false;
        } else if (isNewMode(room)) {
          if (sleepCore(room, idx, 0, true)) return false;
        }
      }
      if (!best || best.score < welfare) {
        if (payWelfare(room, player, kind)) {
          ts.skipped = true;
          return false;
        }
      }
    }
    if (!best) return false;
    if (best.spot === truck.spot) return false; // act in place
    return aiDriveCarTo(room, truck, player, best.spot);
  }


  // Beat two: act where it's parked — place a token when that's worth one,
  // or (duplicate mode) complete matching ride cards when that's worth more.
  function aiActPhase(room, idx) {
    const ts = room.landmarkMania.turnState;
    if (ts.skipped) return;
    const truck = (room.landmarkMania.trucks ?? []).find((t) => t.player === idx);
    const player = room.landmarkMania.players?.[idx];
    if (!truck || !player || truck.spot == null) return;
    const b = buildingAtTruck(room, truck);
    const placeValue = aiPlaceValue(room, idx, player, b);
    if (S(room).rideMode === "duplicate" && b?.role === "loc") {
      const matching = (player.rides ?? []).filter((r) => r.loc === b.bid && !r.faceDown).length;
      const rideValue = matching * cardPoints(room, S(room), player) * 0.95;
      if (matching > 0 && rideValue >= Math.max(placeValue, 0.15)) {
        completeRideCore(room, idx, truck);
        return;
      }
    }
    if (placeValue > 0.15) {
      placeTokenCore(room, idx, truck);
    }
  }

  // How many token locations this player could still use are shut for the
  // current half of the clock — i.e. how much board is waiting on the hour.
  // (A count, not a ratio: as the board fills a ratio drifts under any
  // threshold you pick, which is exactly how the clock once froze solid.)
  function closedCount(room, player) {
    if (hasUp(player, "timeAgnostic")) return 0;
    const seat = (room.landmarkMania.players ?? []).indexOf(player);
    const t = room.landmarkMania.time ?? START_TIME;
    let shut = 0;
    for (const bl of room.landmarkMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role !== "loc" || !Array.isArray(b.slots)) continue;
        if (b.slots.includes(seat) || !b.slots.includes(null)) continue; // not available anyway
        // Forced mode: a circle with somebody else's name on it is never
        // waiting on the hour — it's just not this seat's.
        if (b.owner != null && b.owner !== seat) continue;
        if (Array.isArray(b.pair) && !b.pair.includes(seat)) continue;
        if (!locOpen(S(room), b, t)) shut += 1;
      }
    }
    return shut;
  }

  // The AI buys hours with time stones to cross the day/night line, which
  // reopens the half of the board that's currently shut. Costs a stone an hour
  // like any clock change and burns the same game time. The caller only asks
  // when it has nothing worth driving to, so this is the move that both frees
  // it up and pushes the game toward its last day — there is no other way the
  // clock advances now that resting doesn't sweep it.
  function aiBuyTime(room, seat, player) {
    const ts = room.landmarkMania.turnState;
    if (ts.changedTime) return false;
    if (!isNewMode(room)) return false;
    const t = room.landmarkMania.time ?? START_TIME;
    // Pointless if nothing is actually waiting on the other side of the line.
    if (closedCount(room, player) < 1) return false;
    // Walk forward to the first hour on the other side of the day/night line.
    const wantNight = !isNight(t);
    let cost = 0;
    for (let h = 1; h <= 12; h += 1) {
      if (isNight((t + h) % 24) === wantNight) { cost = h; break; }
    }
    if (!cost || (player.timeStones ?? 0) < cost) return false;
    player.timeStones -= cost;
    ts.changedTime = true;
    runClock(room, cost);
    // The signs carrying the arrival hour's number flip, same as any change.
    const arrival = faceHour(room.landmarkMania.time);
    for (const oct of room.landmarkMania.map.intersections) {
      if (oct.number === arrival) oct.color = oct.color === "green" ? "red" : "green";
    }
    room.landmarkMania.clockMs = CLOCK_MS;
    return true;
  }

  // Keep going (AI): take on a stress level for another leg when there's a
  // clearly worthwhile next stop and enough slack on the stress bar.
  function aiMaybeKeepGoing(room, idx) {
    const ts = room.landmarkMania.turnState;
    if (!ts.acted || ts.destressed || ts.skipped) return false;
    if ((ts.aiLegs ?? 0) >= 3) return false;
    const player = room.landmarkMania.players?.[idx];
    // Keep a buffer: never stress down to the last safe number voluntarily.
    if (!player || (player.stress ?? 2) < 3) return false;
    const truck = (room.landmarkMania.trucks ?? []).find((t) => t.player === idx);
    if (!truck || truck.spot == null) return false;

    const map = room.landmarkMania.map;
    const spots = map.spots ?? [];
    const graph = getAiGraph(room);
    // Score the would-be leg under keep-going rules: rushing bars destress,
    // so those locations mustn't tempt the AI into continuing.
    const wasKept = ts.keptGoing;
    ts.keptGoing = true;
    const cands = aiCandidates(room, idx, truck, player);
    ts.keptGoing = wasKept;
    let best = null;
    for (const c of cands) {
      if (c.spot === truck.spot) continue;
      const here = spots[truck.spot];
      const dest = spots[c.spot];
      const route = findRouteDirected(
        graph, map.intersections, here.x, here.y, truck.facing ?? here.angle, dest.x, dest.y, hasUp(player, "uturn")
      );
      const reds = route ? route.reds : 2;
      const score = c.value - aiRedRisk(room, player, reds) - c.d * 0.0005;
      if (!best || score > best.score) best = { score };
    }
    // The stress level itself is the price — demand a rich next stop.
    if (!best || best.score <= 1.4) return false;

    player.stress -= 1;
    ts.acted = false;
    ts.changedTime = false;
    ts.keptGoing = true;
    ts.aiLegs = (ts.aiLegs ?? 0) + 1;
    ts.undo = null;
    return true;
  }

  function runAiTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "landmark-mania") return;
    const idx = room.landmarkMania.turn;
    if (!room.landmarkMania.players?.[idx]?.isAI) return;
    if (room.landmarkMania.winner != null) return;
    aiRunLeg(roomId, idx);
  }

  // One move+act leg, each beat waiting out the client animations it triggers
  // (clock flip, dice-on-move — none here, the drive). After acting the AI may
  // keep going for another leg; otherwise the turn ends (dice, hand-off).
  function aiRunLeg(roomId, idx) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "landmark-mania") return;
    room.landmarkMania.clockMs = 0;
    const moved = aiMovePhase(room, idx);
    emitState(roomId, room);
    clearAiTimer(roomId);
    const driveMs = moved ? Math.ceil(room.landmarkMania.driveMs ?? 1800) : 0;
    const actDelay = moved
      ? ((room.landmarkMania.clockMs ?? 0) + driveMs + 500) / roomSpeed(room)
      : 250;
    aiTimers.set(roomId, setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r || r.gameId !== "landmark-mania") return;
      aiActPhase(r, idx);
      emitState(roomId, r);
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => {
        const r2 = rooms.get(roomId);
        if (!r2 || r2.gameId !== "landmark-mania") return;
        if (r2.landmarkMania.winner == null && aiMaybeKeepGoing(r2, idx)) {
          emitState(roomId, r2);
          clearAiTimer(roomId);
          aiTimers.set(roomId, setTimeout(() => aiRunLeg(roomId, idx), AI_TURN_GAP_MS / roomSpeed(r2)));
          return;
        }
        endTurnCore(roomId, idx);
      }, 700 / roomSpeed(r)));
    }, actDelay));
  }

  return {
    id: "landmark-mania",

    createRoomState() {
      // New rooms open on the most recently saved tuning, or the defaults.
      const latest = savedSettings[savedSettings.length - 1];
      const settings = cloneSettings(latest?.settings ?? BASE_SETTINGS);
      const state = {
        landmarkMania: {
          map: makeMap(settings),
          time: START_TIME,
          trucks: [],
          settings
        }
      };
      setupBoard(state);
      return state;
    },

    // Re-deal once the real player list is known (two-human rooms were dealt
    // for one by createRoomState).
    onRoomCreated(roomId, room) {
      if (humanCount(room) > 1) setupBoard(room);
    },

    emitState,

    registerHandlers(socket) {
      socket.on("landmark_mania_regenerate", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        room.landmarkMania.map = makeMap(S(room));
        setupBoard(room);
        emitState(roomId, room);
      });

      socket.on("landmark_mania_mix_up", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        room.landmarkMania.map.intersections = randomizeOctagons(room.landmarkMania.map.intersections);
        const bl = S(room).blankLights ?? {};
        setBlankLights(room.landmarkMania.map.intersections, bl.green ?? 6, bl.red ?? 6);
        room.landmarkMania.time = START_TIME;
        emitState(roomId, room);
      });

      // Apply new tuning numbers: the board re-deals under them.
      socket.on("landmark_mania_tune", ({ roomId, settings } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeSettings(settings);
        if (!clean) return;
        applySettingsToRoom(roomId, room, clean);
        emitState(roomId, room);
      });

      socket.on("landmark_mania_list_settings", () => {
        socket.emit("landmark_mania_settings", settingsPayload());
      });

      // Save a named tuning version (local runs only), then apply it to this
      // room — the board re-deals under the new numbers.
      socket.on("landmark_mania_save_settings", ({ roomId, name, settings } = {}) => {
        if (!savingEnabled) return;
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeSettings(settings);
        if (!clean) {
          socket.emit("landmark_mania_settings_error", {
            message: "The server rejected these settings — a board needs at least one location."
          });
          return;
        }
        const entry = {
          id: `s${Date.now()}${Math.floor(Math.random() * 1000)}`,
          name: String(name || "Untitled").slice(0, 40),
          settings: clean
        };
        savedSettings.push(entry);
        persistSavedSettings(savedSettings);
        applySettingsToRoom(roomId, room, clean);
        emitState(roomId, room);
        io.to(roomId).emit("landmark_mania_settings", settingsPayload());
      });

      // Apply a saved tuning version to this room (re-deals).
      socket.on("landmark_mania_load_settings", ({ roomId, settingsId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const entry = savedSettings.find((s) => s.id === settingsId);
        if (!entry) return;
        applySettingsToRoom(roomId, room, entry.settings);
        emitState(roomId, room);
      });

      socket.on("landmark_mania_delete_settings", ({ roomId, settingsId } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const i = savedSettings.findIndex((s) => s.id === settingsId);
        if (i === -1) return;
        savedSettings.splice(i, 1);
        persistSavedSettings(savedSettings);
        io.to(roomId).emit("landmark_mania_settings", settingsPayload());
      });

      socket.on("landmark_mania_rename_settings", ({ roomId, settingsId, name } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const entry = savedSettings.find((s) => s.id === settingsId);
        const clean = String(name ?? "").trim().slice(0, 40);
        if (!entry || !clean) return;
        entry.name = clean;
        persistSavedSettings(savedSettings);
        io.to(roomId).emit("landmark_mania_settings", settingsPayload());
      });

      // Choose how many AI opponents (0 up to the free seats: 3 solo, 2 with
      // two humans). Re-deals the board with that many cars.
      socket.on("landmark_mania_set_opponents", ({ roomId, count } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        room.landmarkMania.aiCount = Math.max(0, Math.min(maxAiFor(room), Number(count) | 0));
        setupBoard(room);
        room.landmarkMania.map.seed = `${room.landmarkMania.map.seed}-o${room.landmarkMania.aiCount}-${Date.now()}`;
        emitState(roomId, room);
      });

      // Drive the player's car to a new spot. Only on their turn, only before
      // placing a token. The client routes and reports the reds crossed; each
      // banks a die. Occupied spots are off limits (no stealing here).
      socket.on("landmark_mania_move_truck", ({ roomId, truckId = 0, spot, reds } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        if (room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        if (room.landmarkMania.turnState.acted) return;
        const truck = humanTruck(room, seat, truckId);
        const spotCount = room.landmarkMania.map.spots?.length ?? 0;
        if (!truck || !Number.isInteger(spot) || spot < 0 || spot >= spotCount) return;
        if (truck.spot === spot) return;
        if ((room.landmarkMania.trucks ?? []).some((t) => t.id !== truck.id && t.spot === spot)) return;

        const ts = room.landmarkMania.turnState;
        const player = room.landmarkMania.players?.[seat];
        ts.undo = {
          kind: "move",
          truckId: truck.id,
          prevSpot: truck.spot,
          prevFacing: truck.facing ?? 0,
          prevTurnTruck: ts.truck ?? null,
          prevDicePool: ts.dicePool ?? 0,
          // Arriving can complete ride cards — an undo brings them back.
          prevRides: (player?.rides ?? []).map((r) => ({ ...r })),
          prevRidesCompleted: player?.ridesCompleted ?? 0
        };
        ts.truck = truck.id;
        applyMove(room, truck, spot, reds);
        emitState(roomId, room);
      });

      // Place a token on the location the car is parked at: needs a token in
      // hand, a free circle, and no token of this player there already. Takes
      // the location's reward and ends the turn's movement.
      socket.on("landmark_mania_place_token", ({ roomId, truckId = 0, bid = null } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck) return;
        // `bid` (optional) targets another location in the parked block —
        // only honored with the nearby-parking upgrade.
        if (placeTokenCore(room, seat, truck, Number.isInteger(bid) ? bid : null)) emitState(roomId, room);
      });

      // Duplicate mode: complete the matching ride card(s) at the parked
      // location — the alternative to visiting it (one or the other).
      socket.on("landmark_mania_complete_ride", ({ roomId, truckId = 0 } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck) return;
        if (completeRideCore(room, seat, truck)) emitState(roomId, room);
      });

      // Welfare / begging: skip the turn — no movement, no location used — for
      // a handout. A clock change doesn't disqualify it. In landmark mode
      // welfare is the daytime offer and begging the night one, so payWelfare
      // refuses the wrong half of the day.
      socket.on("landmark_mania_skip_turn", ({ roomId, kind, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        const ts = room.landmarkMania.turnState;
        if (ts.truck != null || ts.acted) return; // nothing done yet
        const player = room.landmarkMania.players?.[seat];
        if (!player) return;
        if (!payWelfare(room, player, kind === "beg" ? "beg" : "welfare")) return;
        ts.skipped = true;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Sleep: only at night, only in place of the whole turn (like welfare).
      // Stress resets all the way down and the clock may sweep forward up to
      // 4 hours for free; then the turn ends.
      socket.on("landmark_mania_sleep", ({ roomId, hours, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        if (!sleepCore(room, seat, hours)) return;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Nap (landmark mode, daytime): sleeping's smaller daytime sibling —
      // the whole turn for two steps down the stress bar and a short free
      // clock sweep. Landmark mode has no destress locations, so this and
      // sleeping are how the marker comes back down.
      socket.on("landmark_mania_nap", ({ roomId, hours, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        if (!sleepCore(room, seat, hours, true)) return;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Move the clock hand: one stone per hour swept (clockwise only), the
      // two stop signs carrying that number flip, once per turn.
      socket.on("landmark_mania_set_hour", ({ roomId, hour } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        if (!Number.isInteger(hour) || hour < 1 || hour > 12) return;

        const t = room.landmarkMania.time ?? START_TIME;
        const curPos = t % 12;
        const targetPos = hour % 12;
        if (targetPos === curPos) return;

        const player = room.landmarkMania.players?.[seat];
        const ts = room.landmarkMania.turnState;
        // Once per turn — unless the player is a time lord.
        if (ts.changedTime && !hasUp(player, "timeLord")) return;
        const cost = (targetPos - curPos + 12) % 12;
        if (!player || player.timeStones < cost) return;
        player.timeStones -= cost;
        ts.changedTime = true;

        // Sweeping past 6am ends a day, but the reckoning only lands when the
        // turn does — so the undo just has to un-pend it.
        const prevPending = room.landmarkMania.pendingDawn ?? 0;
        runClock(room, cost); // the days tick by
        for (const oct of room.landmarkMania.map.intersections) {
          if (oct.number === hour) {
            oct.color = oct.color === "green" ? "red" : "green";
          }
        }
        ts.undo = { kind: "time", prevTime: t, hour, cost, prevPending };
        emitState(roomId, room);
      });

      // One-step undo: take back the turn's latest move (car returns, banked
      // dice un-bank, completed rides come back) or time change (hand sweeps
      // back, lights flip again, stones refunded).
      socket.on("landmark_mania_undo", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        const ts = room.landmarkMania.turnState;
        const undo = ts.undo;
        const player = room.landmarkMania.players?.[seat];
        if (!undo || !player) return;
        if (undo.kind === "move") {
          // A live undo record means nothing followed the move (placing a
          // token or keeping going clears it) — so if `acted` is set it was
          // the move's own ride completion, and it comes back too.
          const truck = (room.landmarkMania.trucks ?? [])
            .find((t) => t.id === undo.truckId && t.player === seat);
          if (!truck) return;
          truck.spot = undo.prevSpot; // null sends an undone entry back off-board
          truck.facing = undo.prevFacing;
          // An undone move never happened, so the car must not DRIVE back: the
          // client has no route for it, would path-find one in reverse and
          // settle the car facing the wrong way (it looked like a spin). Tell
          // the client to snap it — position and facing both — instead.
          room.landmarkMania.snapCar = { truckId: truck.id, spot: truck.spot, facing: truck.facing };
          ts.truck = undo.prevTurnTruck;
          ts.acted = false;
          ts.dicePool = undo.prevDicePool;
          if (Array.isArray(undo.prevRides)) player.rides = undo.prevRides;
          player.ridesCompleted = undo.prevRidesCompleted ?? player.ridesCompleted;
          room.landmarkMania.lastRoll = null;
        } else if (undo.kind === "time") {
          room.landmarkMania.time = undo.prevTime;
          room.landmarkMania.elapsed = Math.max(0, (room.landmarkMania.elapsed ?? 0) - undo.cost);
          player.timeStones += undo.cost;
          // The dawn hadn't been cashed in yet — just take it off the slate.
          if (undo.prevPending != null) room.landmarkMania.pendingDawn = undo.prevPending;
          for (const oct of room.landmarkMania.map.intersections) {
            if (oct.number === undo.hour) oct.color = oct.color === "green" ? "red" : "green";
          }
          ts.changedTime = false;
        }
        ts.undo = null;
        emitState(roomId, room);
        room.landmarkMania.snapCar = null; // one-shot: only this update carries it
      });

      // Keep going: after movement has ended, take on one stress level (the
      // marker moves up the bar — one fewer safe number) to reopen movement
      // and another time change this turn. Not an option at max stress, and
      // never after a destress location — destressing forces the turn to end.
      socket.on("landmark_mania_keep_going", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        const ts = room.landmarkMania.turnState;
        if (!ts.acted || ts.destressed) return;
        const player = room.landmarkMania.players?.[seat];
        if (!player || (player.stress ?? 2) <= STRESS_MIN) return; // stress is maxed
        player.stress -= 1;
        ts.acted = false;
        ts.changedTime = false; // the clock opens up again too
        ts.keptGoing = true;
        ts.undo = null; // the stressed continuation commits everything before it
        emitState(roomId, room);
      });

      // End the turn: pay the neighbourhood bonuses (`hoodChoices` picks the
      // rewards), roll the banked stress dice (or the fun die when none were
      // banked), then pass the turn — or, once the last day's hours have run
      // out, score the game for everyone.
      socket.on("landmark_mania_end_turn", ({ roomId, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.landmarkMania.turn !== seat || room.landmarkMania.winner != null) return;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Room-wide animation speed dial (×1 … ×3 in half steps).
      socket.on("landmark_mania_set_speed", ({ roomId, speed } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const s = Number(speed);
        if (!Number.isFinite(s)) return;
        room.landmarkMania.speed = Math.min(3, Math.max(1, Math.round(s * 2) / 2));
        emitState(roomId, room);
      });
    }
  };
}
