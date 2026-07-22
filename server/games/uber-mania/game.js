// Uber Mania — a "Traffic Time" game on the Truck Mania city core: the same
// generated streets, stop signs, clock and time stones, and a die banked for
// every red light crossed. No packages, though. The board starts empty and the
// buildings are locations of four types — time stones, tokens, destress, uber
// pickups — each with two open circles. Visiting one lets the player place a
// token of their color on a free circle (once per player per location) and
// take the reward. Ride cards point at uber locations; driving there completes
// them, like Truck Mania's tickets. In the default ride-2 mode each player
// starts with two cards and a completed card is replaced on the spot; in
// ride-pickup mode using any uber pickup deals a fresh card instead. Every
// location belongs to one of ~10 neighbourhoods, drawn as light tinted zones.
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
// settings). Set UBER_MANIA_SAVES=off (e.g. on a hosted deploy) to make the
// list read-only.
const SETTINGS_FILE = fileURLToPath(new URL("./saved-settings.json", import.meta.url));
const savingEnabled = process.env.UBER_MANIA_SAVES !== "off";

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
    console.error("uber-mania: failed to persist settings:", err.message);
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
// 2 — Day, Night: a third of circle locations open in the day (7am–6pm), a
//     third at night (7pm–6am), and a third are unrestricted (no period).
// (Keep these in sync with the client.)
const PERIODS = ["morning", "afternoon", "night"];
const periodOf = (t) => (t >= 6 && t <= 12 ? "morning" : t >= 13 && t <= 20 ? "afternoon" : "night");
const DAY_NIGHT = ["day", "night", null]; // null = no time requirement
const dayNightOf = (t) => (t >= 7 && t <= 18 ? "day" : "night");
// Is this location open right now under the settings' timed scheme?
const locOpen = (settings, b, t) =>
  !b.period || ((settings.timedPeriods ?? 0) === 2 ? dayNightOf(t) : periodOf(t)) === b.period;

const PLAYER_COLORS = ["#3ac0c0", "#e0559c", "#e0a13a", "#7b6fe0"];

// The location types. Upgrade locations take no tokens: they sit dead until
// the one roaming upgrade lands on them, and picking it up is the visit.
const LOC_TYPES = ["timestone", "token", "destress", "upgrade", "uber"];

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

// Uber pickups are landmark places: a big emoji on the board, and the ride
// card carries the name up top with the emoji in the middle.
const UBER_PLACES = [
  { name: "Ferris Wheel", emoji: "🎡" }, { name: "Coaster Park", emoji: "🎢" },
  { name: "Big Top Circus", emoji: "🎪" }, { name: "Movie Palace", emoji: "🎬" },
  { name: "Bowling Lanes", emoji: "🎳" }, { name: "Grand Theatre", emoji: "🎭" },
  { name: "Art Gallery", emoji: "🎨" }, { name: "Old Castle", emoji: "🏰" },
  { name: "The Statue", emoji: "🗽" }, { name: "City Fountain", emoji: "⛲" },
  { name: "Rock Club", emoji: "🎸" }, { name: "The Zoo", emoji: "🦁" },
  { name: "Reef World", emoji: "🐠" }, { name: "Soccer Stadium", emoji: "⚽" },
  { name: "Hoops Arena", emoji: "🏀" }, { name: "Tennis Courts", emoji: "🎾" },
  { name: "Swim Center", emoji: "🏊" }, { name: "Golf Links", emoji: "⛳" },
  { name: "Fishing Pier", emoji: "🎣" }, { name: "City Park", emoji: "🌳" },
  { name: "Volcano Museum", emoji: "🌋" }, { name: "Train Depot", emoji: "🚂" },
  { name: "Campground", emoji: "⛺" }, { name: "Popcorn Plaza", emoji: "🍿" }
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
const DESTRESS_TO = 4; // where sleep lands (superCalm: 5)

// Ride modes: "ride-2" (default) starts every player with two ride cards and
// replaces each one as it completes — uber pickups are destinations only.
// "ride-pickup" is the original rule: visiting any uber pickup deals a card.
// "duplicate" builds on ride-2: no uber pickups at all — every location is a
// one-circle reward location AND a possible ride destination, and landing on
// one is a choice: visit it (the circle) or complete a matching card, never
// both.
const RIDE_MODES = ["ride-2", "ride-pickup", "duplicate"];

const BASE_SETTINGS = {
  rideMode: "ride-2",
  // How many locations of each type get seated (≈45 total).
  locations: { timestone: 11, token: 11, destress: 11, upgrade: 6, uber: 12 },
  // Timed locations: 0 (none — no periods, no rules) or 3 (the three visiting
  // periods; circle locations only open during theirs).
  timedPeriods: 0,
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
  // Welfare: skipping the turn (before doing anything) pays this.
  welfareTokens: 1,
  welfareStones: 2,
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

// Normalize a client-submitted settings object; null only when unusable.
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== "object") return null;
  const locations = {};
  let total = 0;
  for (const type of LOC_TYPES) {
    const v = intClamp(raw.locations?.[type], 0, 30, BASE_SETTINGS.locations[type]);
    locations[type] = v;
    total += v;
  }
  if (total < 1) return null; // a board with no locations isn't a game
  return {
    rideMode: RIDE_MODES.includes(raw.rideMode) ? raw.rideMode : BASE_SETTINGS.rideMode,
    timedPeriods: [2, 3].includes(Number(raw.timedPeriods)) ? Number(raw.timedPeriods) : 0,
    locations,
    timeStoneReward: intClamp(raw.timeStoneReward, 0, 20, BASE_SETTINGS.timeStoneReward),
    tokenReward: intClamp(raw.tokenReward, 0, 20, BASE_SETTINGS.tokenReward),
    startingTokens: intClamp(raw.startingTokens, 0, 60, BASE_SETTINGS.startingTokens),
    startingTimeStones: intClamp(raw.startingTimeStones, 0, 60, BASE_SETTINGS.startingTimeStones),
    startingStress: intClamp(raw.startingStress, STRESS_MIN, STRESS_MAX, BASE_SETTINGS.startingStress),
    tokensPerFail: intClamp(raw.tokensPerFail, 0, 6, BASE_SETTINGS.tokensPerFail),
    neighbourhoods: intClamp(raw.neighbourhoods, 1, HOOD_BASE_COLORS.length, BASE_SETTINGS.neighbourhoods),
    days: intClamp(raw.days, 1, 12, BASE_SETTINGS.days),
    ridePoints: intClamp(raw.ridePoints, 0, 12, BASE_SETTINGS.ridePoints),
    redPenalty: intClamp(raw.redPenalty, 0, 12, BASE_SETTINGS.redPenalty),
    welfareTokens: intClamp(raw.welfareTokens, 0, 20, BASE_SETTINGS.welfareTokens),
    welfareStones: intClamp(raw.welfareStones, 0, 20, BASE_SETTINGS.welfareStones),
    blankLights: {
      green: intClamp(raw.blankLights?.green, 0, 30, BASE_SETTINGS.blankLights.green),
      red: intClamp(raw.blankLights?.red, 0, 30, BASE_SETTINGS.blankLights.red)
    }
  };
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
function assignNeighbourhoods(locations, hoodCount) {
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
  const palette = hoodPalette(k);
  return palette.map((color, i) => ({
    id: i,
    name: HOOD_NAMES[i % HOOD_NAMES.length],
    color
  }));
}

// Deal the location types over the map's reachable buildings and cluster them
// into neighbourhoods. Mutates the map; returns the hoods list.
function assignLocations(map, settings) {
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
  });

  // Duplicate mode: no uber pickups — every location is a one-circle reward
  // location that doubles as a ride destination.
  const duplicate = settings.rideMode === "duplicate";
  const reachable = shuffle(buildings.filter((b) => (b.connectors ?? []).length > 0));
  const bag = [];
  for (const type of LOC_TYPES) {
    if (duplicate && type === "uber") continue;
    for (let i = 0; i < (settings.locations[type] ?? 0); i += 1) bag.push(type);
  }
  const deal = shuffle(bag).slice(0, reachable.length);
  const names = shuffle(LOC_NAMES);
  const places = shuffle(UBER_PLACES);
  const emojis = shuffle(LOC_EMOJIS);
  const timed = [2, 3].includes(settings.timedPeriods ?? 0) ? settings.timedPeriods : 0;
  let ni = 0;
  let pi = 0;
  let pri = 0; // circle locations dealt — round-robins the periods
  const locations = [];
  deal.forEach((type, i) => {
    const b = reachable[i];
    b.role = "loc";
    b.locType = type;
    if (type === "uber") {
      // A landmark: a big emoji on the board, no token circles — visiting
      // completes matching ride cards, and using it deals a fresh one.
      const place = places[pi % places.length];
      const lap = Math.floor(pi / places.length);
      b.name = lap ? `${place.name} ${lap + 1}` : place.name;
      b.emoji = place.emoji;
      pi += 1;
    } else {
      b.name = ni < names.length ? names[ni] : `${names[ni % names.length]} ${Math.floor(ni / names.length) + 1}`;
      ni += 1;
      if (type !== "upgrade") {
        // The token circles: player index or null. One big circle in
        // duplicate mode, two otherwise. (Upgrade locations carry no circles
        // — the roaming upgrade is their whole state.)
        b.slots = duplicate ? [null] : [null, null];
        // Timed locations: round-robin over the shuffled deal spreads the
        // periods evenly across types and neighbourhoods. The Day, Night
        // scheme leaves every third location unrestricted.
        if (timed === 3) {
          b.period = PERIODS[pri % PERIODS.length];
          pri += 1;
        } else if (timed === 2) {
          const p = DAY_NIGHT[pri % DAY_NIGHT.length];
          if (p) b.period = p;
          pri += 1;
        }
      }
    }
    // Duplicate mode: every location gets its own emoji for the ride cards.
    if (duplicate) b.emoji = emojis[i % emojis.length];
    locations.push(b);
  });
  const hoods = assignNeighbourhoods(locations, settings.neighbourhoods);
  // Every location wears its neighbourhood's color.
  const colorById = new Map(hoods.map((h) => [h.id, h.color]));
  locations.forEach((b) => {
    b.color = colorById.get(b.hood) ?? "#d8d3c8";
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

export function createUberManiaGame({ io, rooms }) {
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

  const S = (room) => room.uberMania.settings ?? BASE_SETTINGS;

  // Put a tuning version on the table: apply the numbers and re-deal on a
  // fresh map sized for them.
  function applySettingsToRoom(roomId, room, settings) {
    clearAiTimer(roomId);
    room.uberMania.settings = cloneSettings(settings);
    room.uberMania.map = generateCityMap(Date.now(), genOpts(settings));
    setupBoard(room);
    room.uberMania.map.seed = `${room.uberMania.map.seed}-t${Date.now()}`;
  }

  function genOpts(settings) {
    const total = LOC_TYPES.reduce((n, t) =>
      n + (settings.rideMode === "duplicate" && t === "uber" ? 0 : settings.locations?.[t] ?? 0), 0);
    // Exactly 24 numbered lights + the chosen blanks (the four light-free
    // corners come on top inside the generator).
    const lights = 24 + (settings.blankLights?.green ?? 6) + (settings.blankLights?.red ?? 6);
    // Packed lots: locations fill the blocks wall to wall with small gaps.
    return { dense: true, buildings: total + 4, intersections: lights, packed: true };
  }

  // Deal fresh locations, park the cars off-board, reset every player.
  // Humans hold the first seats, AI fill in behind (up to 4 seats total).
  function setupBoard(room) {
    const settings = S(room);
    const humans = humanCount(room);
    const maxAi = maxAiFor(room);
    const aiCount = Math.max(0, Math.min(maxAi, room.uberMania.aiCount ?? maxAi));
    room.uberMania.aiCount = aiCount;
    room.uberMania.hoods = assignLocations(room.uberMania.map, settings);
    setBlankLights(
      room.uberMania.map.intersections,
      settings.blankLights?.green ?? 6,
      settings.blankLights?.red ?? 6
    );
    room.uberMania.trucks = Array.from({ length: humans + aiCount }, (_, i) => ({
      id: i, player: i, spot: null, facing: 0
    }));
    room.uberMania.players = room.uberMania.trucks.map((t, i) => ({
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      name: i >= humans ? `AI ${i - humans + 1}` : humans === 1 ? "You" : `P${i + 1}`,
      isAI: i >= humans,
      tokens: settings.startingTokens,
      timeStones: settings.startingTimeStones,
      stress: settings.startingStress, // marker between stress and stress+1
      rides: [],          // open ride cards: { id, loc: building bid }
      ridesCompleted: 0,
      upgrades: [],       // upgrade type ids picked up (see UPGRADE_TYPES)
      redTokensLost: 0    // tokens paid to failed red-light dice, for the swing
    }));
    room.uberMania.time = START_TIME;
    room.uberMania.elapsed = 0; // hours the clock has been moved, total
    room.uberMania.turn = 0;
    room.uberMania.turnState = freshTurnState();
    room.uberMania.lastRoll = null;
    room.uberMania.rideSeq = 0;
    if (settings.rideMode !== "ride-pickup") {
      // Ride-2: everyone opens on two face-up ride cards (cars start
      // off-board, so no neighbourhood to steer clear of yet).
      for (const p of room.uberMania.players) {
        dealRide(room, p, null, false);
        dealRide(room, p, null, false);
      }
    }
    room.uberMania.winner = null;
    room.uberMania.results = null;
    room.uberMania.funRoll = null;
    // The race to fill all four upgrade slots: seats in finishing order,
    // scored 7 / 5 / 3 / 1 at game end.
    room.uberMania.upgradeChampions = [];
    // The upgrade supply: a shuffled depleting deck — two copies of every
    // base type plus one neighbourhood upgrade per hood. Once it's empty no
    // new upgrade appears on the board.
    room.uberMania.upgradeDeck = shuffle([
      ...UPGRADE_TYPES, ...UPGRADE_TYPES,
      ...(room.uberMania.hoods ?? []).map((h) => `hood:${h.id}`)
    ]);
    // One roaming upgrade: it starts at a random upgrade location and hops to
    // another (as the next draw from the deck) whenever someone picks it up.
    room.uberMania.upgradeAt = pickUpgradeLocation(room, null);
    room.uberMania.upgradeType = room.uberMania.upgradeAt != null ? drawUpgrade(room) : null;
    room.uberMania.aiGraph = null; // rebuilt lazily against the current map
    room.uberMania.aiMove = null;  // transient: an AI's drive, for the clients to animate
  }

  // Draw the next upgrade off the depleting deck (null once it runs dry).
  function drawUpgrade(room) {
    const deck = room.uberMania.upgradeDeck ?? [];
    return deck.length ? deck.pop() : null;
  }

  // How many upgrades this player may hold: two by default, a third slot for
  // a token in every neighbourhood, a fourth for two in every neighbourhood.
  // Only top-of-circle tokens count (undercut tokens sit beneath and don't);
  // a hood with fewer claimable locations than the requirement only demands
  // what it has, so a thin hood can't lock the slots forever.
  function upgradeCap(room, seat) {
    const total = new Map();
    const have = new Map();
    for (const bl of room.uberMania.map.blocks ?? []) {
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
    for (const bl of room.uberMania.map.blocks ?? []) {
      for (const b of bl.buildings ?? []) {
        if (b.role === "loc" && b.hood === hood && Array.isArray(b.slots) && b.slots.includes(seat)) n += 1;
      }
    }
    return n;
  }

  // A random upgrade location other than `notBid` — falling back to `notBid`
  // itself when it's the only one, or null when the board has none.
  function pickUpgradeLocation(room, notBid) {
    const locs = (room.uberMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
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
  function finalizeGame(room) {
    const settings = S(room);
    const players = room.uberMania.players ?? [];
    const losses = players.map((p) => p.redTokensLost ?? 0);
    const mostLost = Math.max(...losses);
    const leastLost = Math.min(...losses);
    const champs = room.uberMania.upgradeChampions ?? [];
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
    room.uberMania.results = { perPlayer, winners };
    room.uberMania.winner = winners[0] ?? null;
  }

  function emitState(roomId, room) {
    const time = room.uberMania.time ?? START_TIME;
    io.to(roomId).emit("state_update", {
      uberMania: {
        map: room.uberMania.map,
        hoods: room.uberMania.hoods ?? [],
        hour: faceHour(time),
        time,
        night: isNight(time),
        turn: room.uberMania.turn ?? 0,
        turnState: room.uberMania.turnState ?? freshTurnState(),
        winner: room.uberMania.winner ?? null,
        results: room.uberMania.results ?? null,
        elapsed: room.uberMania.elapsed ?? 0,
        speed: roomSpeed(room),
        settings: S(room),
        upgradeAt: room.uberMania.upgradeAt ?? null,
        upgradeType: room.uberMania.upgradeType ?? null,
        upgradeDeckCount: (room.uberMania.upgradeDeck ?? []).length,
        upgradeChampions: room.uberMania.upgradeChampions ?? [],
        maxAi: maxAiFor(room), // free seats — bounds the AI-count picker
        aiMove: room.uberMania.aiMove ?? null,
        trucks: room.uberMania.trucks,
        // Each player carries their current upgrade capacity (2–4 slots).
        players: (room.uberMania.players ?? []).map((p, i) => ({
          ...p, upgradeCap: upgradeCap(room, i)
        })),
        lastRoll: room.uberMania.lastRoll ?? null,
        funRoll: room.uberMania.funRoll ?? null
      },
      turn: room.turn
    });
  }

  function playerRoom(socket, roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "uber-mania") return null;
    if (!room.players.includes(socket.id)) return null;
    return room;
  }

  const seatOf = (room, socket) => room.players.indexOf(socket.id);
  const roomSpeed = (room) => Math.min(3, Math.max(1, room.uberMania.speed ?? 3));

  function humanTruck(room, seat, truckId) {
    const t = (room.uberMania.trucks ?? []).find((x) => x.id === truckId);
    if (!t || t.player !== seat) return null;
    const ts = room.uberMania.turnState;
    if (ts.truck !== null && ts.truck !== truckId) return null;
    return t;
  }

  // The building the car's parking spot belongs to.
  function buildingAtTruck(room, truck) {
    const spot = room.uberMania.map.spots?.[truck.spot];
    return spot ? buildingByBid(room.uberMania.map, spot.building) : null;
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
    if (!b || b.role !== "loc" || b.locType !== "uber") return;
    // Face-down cards are inert — they only join the hand when the turn ends.
    const done = player.rides.filter((r) => r.loc === b.bid && !r.faceDown).length;
    if (!done) return;
    player.rides = player.rides.filter((r) => r.loc !== b.bid || r.faceDown);
    player.ridesCompleted = (player.ridesCompleted ?? 0) + done;
    if (S(room).rideMode !== "ride-pickup") {
      for (let i = 0; i < done; i += 1) dealRide(room, player, b);
    }
    const ts = room.uberMania.turnState;
    ts.truck = truck.id;
    ts.acted = true; // the completed ride is the turn's action (undo can revoke it)
  }

  // Park the car and bank a die per red light crossed (rolled at turn end).
  function applyMove(room, truck, spot, reds) {
    truck.spot = spot;
    const player = room.uberMania.players?.[truck.player];
    const n = Number.isInteger(reds) ? Math.max(0, Math.min(12, reds)) : 0;
    const ts = room.uberMania.turnState;
    ts.dicePool = Math.min(12, (ts.dicePool ?? 0) + n);
    room.uberMania.lastRoll = null;
    resolveRidesAt(room, truck, player);
  }

  // Deal a ride card: a random OTHER uber location on the board — never one
  // in the neighbourhood the player is standing in (`from` is the building
  // they're at, or null off-board), unless every other uber location shares it.
  // Cards dealt mid-turn arrive face down: inert until the turn ends and they
  // flip up (the setup deal is face up — the game opens on known cards).
  function dealRide(room, player, from = null, faceDown = true) {
    // Ride destinations: uber pickups — or, in duplicate mode, any location.
    const duplicate = S(room).rideMode === "duplicate";
    const dests = (room.uberMania.map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
      .filter((b) => b.role === "loc" && (duplicate || b.locType === "uber") && b.bid !== from?.bid);
    if (!dests.length) return;
    const otherHood = from?.hood != null ? dests.filter((b) => b.hood !== from.hood) : dests;
    const locs = (otherHood.length ? otherHood : dests).map((b) => b.bid);
    room.uberMania.rideSeq = (room.uberMania.rideSeq ?? 0) + 1;
    const ride = {
      id: `r${room.uberMania.rideSeq}`,
      loc: locs[Math.floor(Math.random() * locs.length)]
    };
    if (faceDown) ride.faceDown = true;
    player.rides.push(ride);
  }

  // Use the location the car is parked at. Shared by the socket handler and
  // the AI; returns the building or null. Token-circle locations (time stone /
  // token / destress) take a token onto a free circle — once per player per
  // location — and pay the reward. Uber pickups are free and unlimited: each
  // use just deals a fresh ride card. Either way it ends the turn's movement.
  function placeTokenCore(room, seat, truck, targetBid = null) {
    const ts = room.uberMania.turnState;
    if (ts.acted || room.uberMania.winner != null) return null;
    if (!truck || truck.spot == null) return null;
    const player = room.uberMania.players?.[seat];
    if (!player) return null;
    let b = buildingAtTruck(room, truck);
    if (!b) return null;
    if (targetBid != null && targetBid !== b.bid) {
      // Nearby parking: use any location in the block the car is parked at.
      if (!hasUp(player, "nearbyParking")) return null;
      const block = (room.uberMania.map.blocks ?? [])
        .find((bl) => (bl.buildings ?? []).some((x) => x.bid === b.bid));
      const target = (block?.buildings ?? []).find((x) => x.bid === targetBid);
      if (!target) return null;
      b = target;
    }
    if (b.role !== "loc") return null;

    if (b.locType === "uber") {
      // Pickups deal cards only in ride-pickup mode; in ride-2 they're pure
      // destinations — arriving already completed any matching cards.
      if (S(room).rideMode !== "ride-pickup") return null;
      dealRide(room, player, b);
    } else if (b.locType === "upgrade") {
      // Free to use, no token — but only the one location currently holding
      // the roaming upgrade; the rest sit dead. Picking it up respawns the
      // deck's next draw at another upgrade location. The player board caps
      // the hand: two slots, plus the neighbourhood-visit unlocks.
      if (room.uberMania.upgradeAt !== b.bid) return null;
      const type = room.uberMania.upgradeType;
      if (!type) return null;
      if ((player.upgrades ?? []).length >= upgradeCap(room, seat)) return null;
      (player.upgrades ??= []).push(type);
      // Extra ride kicks in immediately: the hand grows by one card.
      if (type === "extraRide" && S(room).rideMode !== "ride-pickup") {
        dealRide(room, player, b);
      }
      // Filling all four slots joins the champions' race (7 / 5 / 3 / 1).
      if (player.upgrades.length >= 4) {
        const champs = (room.uberMania.upgradeChampions ??= []);
        if (!champs.includes(seat)) champs.push(seat);
      }
      room.uberMania.upgradeType = drawUpgrade(room);
      room.uberMania.upgradeAt = room.uberMania.upgradeType
        ? pickUpgradeLocation(room, b.bid)
        : null;
    } else {
      if ((player.tokens ?? 0) < 1) return null;
      if (!Array.isArray(b.slots)) return null;
      // One token per player per location — on top or beneath.
      if (b.slots.includes(seat) || (b.under ?? []).includes(seat)) return null;
      // Calming and rushing don't mix: no destress on a turn that kept going.
      if (b.locType === "destress" && ts.keptGoing) return null;
      // Timed locations: a location only opens during its time period —
      // unless the player is time agnostic.
      if (!hasUp(player, "timeAgnostic") && !locOpen(S(room), b, room.uberMania.time ?? START_TIME)) return null;
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
      } else if (b.locType === "token") {
        player.tokens += (settings.tokenReward ?? 3) + bonusTokens(player);
      } else if (b.locType === "destress") {
        // One gap down the bar — one more safe number, capped at the bottom.
        // (Sleeping is the full reset now.)
        player.stress = Math.min(STRESS_MAX, (player.stress ?? 2) + 1);
        ts.destressed = true; // destressing forces the turn to end — no keep going
      }
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
    const ts = room.uberMania.turnState;
    if (ts.acted || room.uberMania.winner != null) return null;
    if (!truck || truck.spot == null) return null;
    const player = room.uberMania.players?.[seat];
    if (!player) return null;
    const b = buildingAtTruck(room, truck);
    if (!b || b.role !== "loc") return null;
    const done = (player.rides ?? []).filter((r) => r.loc === b.bid && !r.faceDown).length;
    if (!done) return null;
    player.rides = player.rides.filter((r) => r.loc !== b.bid || r.faceDown);
    player.ridesCompleted = (player.ridesCompleted ?? 0) + done;
    for (let i = 0; i < done; i += 1) dealRide(room, player, b);
    ts.truck = truck.id;
    ts.acted = true;
    ts.undo = null; // the completion commits everything before it
    return b;
  }

  // Extra cash / extra time ride along with EVERY token / stone collection —
  // locations, welfare, neighbourhood bonuses, the fun die (but a zero-sized
  // collection stays zero).
  const bonusTokens = (player) => (hasUp(player, "extraCash") ? 1 : 0);
  const bonusStones = (player) => (hasUp(player, "extraTime") ? 2 : 0);

  // Welfare: sitting the turn out pays a token and some time stones.
  function payWelfare(room, player) {
    const t = S(room).welfareTokens ?? 1;
    const s = S(room).welfareStones ?? 2;
    player.tokens = (player.tokens ?? 0) + t + (t > 0 ? bonusTokens(player) : 0);
    player.timeStones = (player.timeStones ?? 0) + s + (s > 0 ? bonusStones(player) : 0);
  }

  // Sleep: only at night (7pm–6am), only in place of the whole turn — like
  // welfare, nothing moved and no location used. Stress drops all the way to
  // between 4 and 5 (super calm: between 5 and 6), and the sleeper may sweep
  // the clock forward up to 4 hours for free. Ends the turn.
  function sleepCore(room, seat, hours) {
    const ts = room.uberMania.turnState;
    if (ts.truck != null || ts.acted || room.uberMania.winner != null) return false;
    const t = room.uberMania.time ?? START_TIME;
    if (!isNight(t)) return false;
    const player = room.uberMania.players?.[seat];
    if (!player) return false;
    player.stress = Math.max(player.stress ?? 2, hasUp(player, "superCalm") ? 5 : DESTRESS_TO);
    const h = Math.max(0, Math.min(4, Number(hours) | 0));
    if (h > 0) {
      room.uberMania.time = (t + h) % 24;
      room.uberMania.elapsed = (room.uberMania.elapsed ?? 0) + h;
      // Same rule as a paid clock change: the signs carrying the arrival
      // hour's number flip.
      const arrival = faceHour(room.uberMania.time);
      for (const oct of room.uberMania.map.intersections) {
        if (oct.number === arrival) oct.color = oct.color === "green" ? "red" : "green";
      }
    }
    ts.skipped = true;
    return true;
  }

  // End-of-turn beat: roll the banked dice against the roller's stress marker
  // (between `stress` and `stress+1`) — every die over it costs tokens.
  // Returns how long clients will animate the roll (0 when nothing rolled).
  function rollStressDice(room, playerIdx) {
    const player = room.uberMania.players?.[playerIdx];
    const ts = room.uberMania.turnState;
    const n = Math.max(0, Math.min(12, ts?.dicePool ?? 0));
    if (player && n > 0) {
      const stress = player.stress ?? 2;
      const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
      const fails = dice.filter((d) => d > stress).length;
      const loss = Math.min(player.tokens ?? 0, fails * (S(room).tokensPerFail ?? 1));
      player.tokens = Math.max(0, (player.tokens ?? 0) - fails * (S(room).tokensPerFail ?? 1));
      player.redTokensLost = (player.redTokensLost ?? 0) + loss; // the end-game swing tracks this
      room.uberMania.rollSeq = (room.uberMania.rollSeq || 0) + 1;
      room.uberMania.lastRoll = {
        seq: room.uberMania.rollSeq, player: playerIdx, dice,
        aversion: stress, // the safe-roll threshold, named as the client's dice code expects
        tickets: fails,   // failed dice (drives the shared dice animation)
        loss,             // tokens actually paid
        mode: "tokens"
      };
      return diceMsFor(room.uberMania.lastRoll);
    }
    room.uberMania.lastRoll = null;
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
    const player = room.uberMania.players?.[seat];
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === seat);
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
    const player = room.uberMania.players?.[seat];
    if (!player) return 0;
    const face = HOOD_REWARDS[Math.floor(Math.random() * HOOD_REWARDS.length)];
    if (face === "token") {
      player.tokens = (player.tokens ?? 0) + 1 + bonusTokens(player);
    } else if (face === "stones") {
      player.timeStones = (player.timeStones ?? 0) + 2 + bonusStones(player);
    } else {
      player.stress = Math.min(STRESS_MAX, (player.stress ?? 2) + 1);
    }
    room.uberMania.funSeq = (room.uberMania.funSeq || 0) + 1;
    room.uberMania.funRoll = { seq: room.uberMania.funSeq, player: seat, face };
    return FUN_DIE_MS;
  }

  // The shared end-of-turn path (humans and AI): pay the neighbourhood
  // bonuses, roll the banked dice (or the fun die when none banked), then
  // either score the game (the days have run out) or pass the turn.
  function endTurnCore(roomId, seat, hoodChoices = []) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "uber-mania") return;
    // The turn is over: cards drawn this turn flip face up.
    for (const r of room.uberMania.players?.[seat]?.rides ?? []) delete r.faceDown;
    grantHoodBonuses(room, seat, hoodChoices);
    const ts = room.uberMania.turnState;
    room.uberMania.funRoll = null;
    let rollMs;
    if ((ts?.dicePool ?? 0) === 0 && !ts?.skipped) {
      room.uberMania.lastRoll = null;
      rollMs = rollFunDie(room, seat);
    } else {
      rollMs = rollStressDice(room, seat);
    }
    const endHours = (S(room).days ?? 3) * 24;
    if ((room.uberMania.elapsed ?? 0) >= endHours) {
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
    if (!room || room.gameId !== "uber-mania") return;
    if (room.uberMania.winner != null) {
      emitState(roomId, room);
      return;
    }
    const n = room.uberMania.players?.length ?? 1;
    room.uberMania.turn = ((room.uberMania.turn ?? 0) + 1) % n;
    room.uberMania.turnState = freshTurnState();
    room.uberMania.aiMove = null;
    emitState(roomId, room);
    if (room.uberMania.players[room.uberMania.turn]?.isAI) {
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => runAiTurn(roomId), (AI_TURN_GAP_MS + extraMs) / roomSpeed(room)));
    }
  }

  function getAiGraph(room) {
    const map = room.uberMania.map;
    const cache = room.uberMania.aiGraph;
    if (cache && cache.seed === map.seed) return cache.graph;
    const graph = buildStreetGraph(map.streets, map.spots ?? []);
    room.uberMania.aiGraph = { seed: map.seed, graph };
    return graph;
  }

  // Stones the AI will spend on one clock flip — scales with its stash.
  function aiTimeBudget(player) {
    const s = player.timeStones ?? 0;
    if (s <= 0) return 0;
    return Math.min(11, Math.max(4, Math.floor(s * 0.6)));
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
    const ts = room.uberMania.turnState;
    if (ts.changedTime) return false; // once per turn
    const budget = aiTimeBudget(player);
    if (!numbers.length || budget <= 0) return false;
    const redCount = {};
    numbers.forEach((n) => { redCount[n] = (redCount[n] || 0) + 1; });
    const greenCount = {};
    greens.forEach((n) => { greenCount[n] = (greenCount[n] || 0) + 1; });
    const t = room.uberMania.time ?? START_TIME;
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
    room.uberMania.time = (t + best.cost) % 24;
    room.uberMania.elapsed = (room.uberMania.elapsed ?? 0) + best.cost;
    for (const oct of room.uberMania.map.intersections) {
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
    const map = room.uberMania.map;
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
    room.uberMania.aiMove = { truckId: truck.id, path, endAngle: best.route.endAngle };
    room.uberMania.driveMs = Math.max(450, (pathLen(path) / CAR_SPEED) * 1000) + 300;
    return true;
  }

  // Drive the AI's car to a spot, greening a red on the way when affordable.
  function aiDriveCarTo(room, truck, player, destSpotIdx) {
    if (truck.spot == null) return aiEnterCar(room, truck, player, destSpotIdx);
    const map = room.uberMania.map;
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
        room.uberMania.clockMs = CLOCK_MS;
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
    room.uberMania.aiMove = { truckId: truck.id, path, endAngle };
    room.uberMania.driveMs = Math.max(450, (pathLen(path) / CAR_SPEED) * 1000) + 300;
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
    if (b.locType === "uber") {
      if (settings.rideMode !== "ride-pickup") return 0; // destinations only
      const open = player.rides?.length ?? 0;
      return (0.55 * (settings.ridePoints ?? 2)) / (1 + open);
    }
    if (b.locType === "upgrade") {
      // Free action for a real perk — but a type the AI already holds is
      // nearly worthless, dead spots are worth nothing, and a full player
      // board can't take one at all.
      if (room.uberMania.upgradeAt !== b.bid || !room.uberMania.upgradeType) return 0;
      const held = (player.upgrades ?? []).length;
      if (held >= upgradeCap(room, seat)) return 0;
      if (hasUp(player, room.uberMania.upgradeType)) return 0.15;
      // The fourth pickup banks the champions' race points (7 / 5 / 3 / 1).
      const racePts = held === 3
        ? Math.max(1, 7 - 2 * (room.uberMania.upgradeChampions ?? []).length)
        : 0;
      return 1.1 + racePts * 0.5;
    }
    if (!Array.isArray(b.slots)) return 0;
    if ((player.tokens ?? 0) < 1) return 0;
    if (b.slots.includes(seat) || (b.under ?? []).includes(seat)) return 0;
    // A full location only takes an undercut token (no unlock progress).
    const under = !b.slots.includes(null);
    if (under && !hasUp(player, "undercut")) return 0;
    // Timed locations: closed outside its time period (the AI doesn't plan
    // clock flips around visits — it just reads the clock as it stands).
    // Time-agnostic players ignore the gate.
    if (!hasUp(player, "timeAgnostic") && !locOpen(settings, b, room.uberMania.time ?? START_TIME)) return 0;
    let v = -TOKEN_VALUE; // the token played
    if (b.locType === "timestone") {
      v += (player.timeStones < 4 ? 0.22 : 0.13) * (settings.timeStoneReward ?? 4);
    } else if (b.locType === "destress") {
      // Calming is off the table on a turn that rushed (kept going).
      if (room.uberMania.turnState?.keptGoing) return 0;
      // One step down the bar — worth more the higher the marker sits.
      const stress = player.stress ?? 2;
      v += stress >= STRESS_MAX ? 0.02 : 0.5 + 0.15 * (DESTRESS_TO - stress);
    } else if (b.locType === "token") {
      v += TOKEN_VALUE * (settings.tokenReward ?? 3);
    }
    if (!under && b.hood != null) {
      // Visits unlock upgrade slots: fresh hoods matter most, seconds count.
      const c = hoodVisits(room, seat, b.hood);
      if (c === 0) v += 0.5;
      else if (c === 1) v += 0.25;
    }
    return v;
  }

  // Expected token cost of crossing `reds` red lights at this stress level.
  function aiRedRisk(room, player, reds) {
    if (!reds) return 0;
    const stress = player.stress ?? 2;
    const pFail = (6 - Math.max(1, Math.min(5, stress))) / 6;
    return reds * pFail * (S(room).tokensPerFail ?? 1) * TOKEN_VALUE + reds * 0.05;
  }

  // Every worthwhile destination for the AI's car: places it could place a
  // token, and the destinations of its open ride cards (arrival completes
  // them). Each is { spot, d, value }.
  function aiCandidates(room, seat, truck, player) {
    const map = room.uberMania.map;
    const spots = map.spots ?? [];
    const here = truck.spot != null ? spots[truck.spot] : null;
    const entries = here ? null : edgeLights(map);
    const distTo = (s) => (here
      ? Math.hypot(s.x - here.x, s.y - here.y)
      : Math.min(...entries.map((o) => Math.hypot(s.x - o.x, s.y - o.y))));
    const occupied = new Set(
      (room.uberMania.trucks ?? []).filter((t) => t.id !== truck.id).map((t) => t.spot));
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
      const rideValue = matching * (settings.ridePoints ?? 2) * 0.95;
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
    const player = room.uberMania.players?.[idx];
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === idx);
    if (!player || !truck) return false;
    const map = room.uberMania.map;
    const spots = map.spots ?? [];
    const graph = getAiGraph(room);
    const ts = room.uberMania.turnState;

    const cands = aiCandidates(room, idx, truck, player)
      .sort((a, b) => (b.value - b.d * 0.0005) - (a.value - a.d * 0.0005));

    let best = null;
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
      if (!best || score > best.score) best = { ...c, score };
    }

    // Sleeping or welfare beats a bad board — but not on a keep-going
    // continuation (the turn already acted; there's no skip left to take).
    if (!ts.keptGoing) {
      const settings = S(room);
      // Sleep off a stressed night: the full reset outweighs a mediocre stop.
      if (isNight(room.uberMania.time ?? START_TIME) && (player.stress ?? 2) <= 2 &&
          (!best || best.score < 1.2)) {
        if (sleepCore(room, idx, 0)) return false;
      }
      const welfare = TOKEN_VALUE * (settings.welfareTokens ?? 1) + 0.1 * (settings.welfareStones ?? 2);
      if (!best || best.score < welfare) {
        payWelfare(room, player);
        ts.skipped = true;
        return false;
      }
    }
    if (!best) return false;
    if (best.spot === truck.spot) return false; // act in place
    return aiDriveCarTo(room, truck, player, best.spot);
  }

  // Beat two: act where it's parked — place a token when that's worth one,
  // or (duplicate mode) complete matching ride cards when that's worth more.
  function aiActPhase(room, idx) {
    const ts = room.uberMania.turnState;
    if (ts.skipped) return;
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === idx);
    const player = room.uberMania.players?.[idx];
    if (!truck || !player || truck.spot == null) return;
    const b = buildingAtTruck(room, truck);
    const placeValue = aiPlaceValue(room, idx, player, b);
    if (S(room).rideMode === "duplicate" && b?.role === "loc") {
      const matching = (player.rides ?? []).filter((r) => r.loc === b.bid && !r.faceDown).length;
      const rideValue = matching * (S(room).ridePoints ?? 2) * 0.95;
      if (matching > 0 && rideValue >= Math.max(placeValue, 0.15)) {
        completeRideCore(room, idx, truck);
        return;
      }
    }
    if (placeValue > 0.15) {
      placeTokenCore(room, idx, truck);
    }
  }

  // Keep going (AI): take on a stress level for another leg when there's a
  // clearly worthwhile next stop and enough slack on the stress bar.
  function aiMaybeKeepGoing(room, idx) {
    const ts = room.uberMania.turnState;
    if (!ts.acted || ts.destressed || ts.skipped) return false;
    if ((ts.aiLegs ?? 0) >= 3) return false;
    const player = room.uberMania.players?.[idx];
    // Keep a buffer: never stress down to the last safe number voluntarily.
    if (!player || (player.stress ?? 2) < 3) return false;
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === idx);
    if (!truck || truck.spot == null) return false;

    const map = room.uberMania.map;
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
    if (!room || room.gameId !== "uber-mania") return;
    const idx = room.uberMania.turn;
    if (!room.uberMania.players?.[idx]?.isAI) return;
    if (room.uberMania.winner != null) return;
    aiRunLeg(roomId, idx);
  }

  // One move+act leg, each beat waiting out the client animations it triggers
  // (clock flip, dice-on-move — none here, the drive). After acting the AI may
  // keep going for another leg; otherwise the turn ends (dice, hand-off).
  function aiRunLeg(roomId, idx) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "uber-mania") return;
    room.uberMania.clockMs = 0;
    const moved = aiMovePhase(room, idx);
    emitState(roomId, room);
    clearAiTimer(roomId);
    const driveMs = moved ? Math.ceil(room.uberMania.driveMs ?? 1800) : 0;
    const actDelay = moved
      ? ((room.uberMania.clockMs ?? 0) + driveMs + 500) / roomSpeed(room)
      : 250;
    aiTimers.set(roomId, setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r || r.gameId !== "uber-mania") return;
      aiActPhase(r, idx);
      emitState(roomId, r);
      clearAiTimer(roomId);
      aiTimers.set(roomId, setTimeout(() => {
        const r2 = rooms.get(roomId);
        if (!r2 || r2.gameId !== "uber-mania") return;
        if (r2.uberMania.winner == null && aiMaybeKeepGoing(r2, idx)) {
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
    id: "uber-mania",

    createRoomState() {
      // New rooms open on the most recently saved tuning, or the defaults.
      const latest = savedSettings[savedSettings.length - 1];
      const settings = cloneSettings(latest?.settings ?? BASE_SETTINGS);
      const state = {
        uberMania: {
          map: generateCityMap(Date.now(), genOpts(settings)),
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
      socket.on("uber_mania_regenerate", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        room.uberMania.map = generateCityMap(Date.now(), genOpts(S(room)));
        setupBoard(room);
        emitState(roomId, room);
      });

      socket.on("uber_mania_mix_up", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        room.uberMania.map.intersections = randomizeOctagons(room.uberMania.map.intersections);
        const bl = S(room).blankLights ?? {};
        setBlankLights(room.uberMania.map.intersections, bl.green ?? 6, bl.red ?? 6);
        room.uberMania.time = START_TIME;
        emitState(roomId, room);
      });

      // Apply new tuning numbers: the board re-deals under them.
      socket.on("uber_mania_tune", ({ roomId, settings } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeSettings(settings);
        if (!clean) return;
        applySettingsToRoom(roomId, room, clean);
        emitState(roomId, room);
      });

      socket.on("uber_mania_list_settings", () => {
        socket.emit("uber_mania_settings", settingsPayload());
      });

      // Save a named tuning version (local runs only), then apply it to this
      // room — the board re-deals under the new numbers.
      socket.on("uber_mania_save_settings", ({ roomId, name, settings } = {}) => {
        if (!savingEnabled) return;
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const clean = sanitizeSettings(settings);
        if (!clean) {
          socket.emit("uber_mania_settings_error", {
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
        io.to(roomId).emit("uber_mania_settings", settingsPayload());
      });

      // Apply a saved tuning version to this room (re-deals).
      socket.on("uber_mania_load_settings", ({ roomId, settingsId } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const entry = savedSettings.find((s) => s.id === settingsId);
        if (!entry) return;
        applySettingsToRoom(roomId, room, entry.settings);
        emitState(roomId, room);
      });

      socket.on("uber_mania_delete_settings", ({ roomId, settingsId } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const i = savedSettings.findIndex((s) => s.id === settingsId);
        if (i === -1) return;
        savedSettings.splice(i, 1);
        persistSavedSettings(savedSettings);
        io.to(roomId).emit("uber_mania_settings", settingsPayload());
      });

      socket.on("uber_mania_rename_settings", ({ roomId, settingsId, name } = {}) => {
        if (!savingEnabled) return;
        if (!playerRoom(socket, roomId)) return;
        const entry = savedSettings.find((s) => s.id === settingsId);
        const clean = String(name ?? "").trim().slice(0, 40);
        if (!entry || !clean) return;
        entry.name = clean;
        persistSavedSettings(savedSettings);
        io.to(roomId).emit("uber_mania_settings", settingsPayload());
      });

      // Choose how many AI opponents (0 up to the free seats: 3 solo, 2 with
      // two humans). Re-deals the board with that many cars.
      socket.on("uber_mania_set_opponents", ({ roomId, count } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        room.uberMania.aiCount = Math.max(0, Math.min(maxAiFor(room), Number(count) | 0));
        setupBoard(room);
        room.uberMania.map.seed = `${room.uberMania.map.seed}-o${room.uberMania.aiCount}-${Date.now()}`;
        emitState(roomId, room);
      });

      // Drive the player's car to a new spot. Only on their turn, only before
      // placing a token. The client routes and reports the reds crossed; each
      // banks a die. Occupied spots are off limits (no stealing here).
      socket.on("uber_mania_move_truck", ({ roomId, truckId = 0, spot, reds } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        if (room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        if (room.uberMania.turnState.acted) return;
        const truck = humanTruck(room, seat, truckId);
        const spotCount = room.uberMania.map.spots?.length ?? 0;
        if (!truck || !Number.isInteger(spot) || spot < 0 || spot >= spotCount) return;
        if (truck.spot === spot) return;
        if ((room.uberMania.trucks ?? []).some((t) => t.id !== truck.id && t.spot === spot)) return;

        const ts = room.uberMania.turnState;
        const player = room.uberMania.players?.[seat];
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
      socket.on("uber_mania_place_token", ({ roomId, truckId = 0, bid = null } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck) return;
        // `bid` (optional) targets another location in the parked block —
        // only honored with the nearby-parking upgrade.
        if (placeTokenCore(room, seat, truck, Number.isInteger(bid) ? bid : null)) emitState(roomId, room);
      });

      // Duplicate mode: complete the matching ride card(s) at the parked
      // location — the alternative to visiting it (one or the other).
      socket.on("uber_mania_complete_ride", ({ roomId, truckId = 0 } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck) return;
        if (completeRideCore(room, seat, truck)) emitState(roomId, room);
      });

      // Welfare: skip the turn — no movement, no location used — for a token
      // and some time stones. A clock change doesn't disqualify it.
      socket.on("uber_mania_skip_turn", ({ roomId, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const ts = room.uberMania.turnState;
        if (ts.truck != null || ts.acted) return; // nothing done yet
        const player = room.uberMania.players?.[seat];
        if (!player) return;
        payWelfare(room, player);
        ts.skipped = true;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Sleep: only at night, only in place of the whole turn (like welfare).
      // Stress resets all the way down and the clock may sweep forward up to
      // 4 hours for free; then the turn ends.
      socket.on("uber_mania_sleep", ({ roomId, hours, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        if (!sleepCore(room, seat, hours)) return;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Move the clock hand: one stone per hour swept (clockwise only), the
      // two stop signs carrying that number flip, once per turn.
      socket.on("uber_mania_set_hour", ({ roomId, hour } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        if (!Number.isInteger(hour) || hour < 1 || hour > 12) return;

        const t = room.uberMania.time ?? START_TIME;
        const curPos = t % 12;
        const targetPos = hour % 12;
        if (targetPos === curPos) return;

        const player = room.uberMania.players?.[seat];
        const ts = room.uberMania.turnState;
        // Once per turn — unless the player is a time lord.
        if (ts.changedTime && !hasUp(player, "timeLord")) return;
        const cost = (targetPos - curPos + 12) % 12;
        if (!player || player.timeStones < cost) return;
        player.timeStones -= cost;
        ts.changedTime = true;

        room.uberMania.time = (t + cost) % 24;
        room.uberMania.elapsed = (room.uberMania.elapsed ?? 0) + cost; // the days tick by
        for (const oct of room.uberMania.map.intersections) {
          if (oct.number === hour) {
            oct.color = oct.color === "green" ? "red" : "green";
          }
        }
        ts.undo = { kind: "time", prevTime: t, hour, cost };
        emitState(roomId, room);
      });

      // One-step undo: take back the turn's latest move (car returns, banked
      // dice un-bank, completed rides come back) or time change (hand sweeps
      // back, lights flip again, stones refunded).
      socket.on("uber_mania_undo", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const ts = room.uberMania.turnState;
        const undo = ts.undo;
        const player = room.uberMania.players?.[seat];
        if (!undo || !player) return;
        if (undo.kind === "move") {
          // A live undo record means nothing followed the move (placing a
          // token or keeping going clears it) — so if `acted` is set it was
          // the move's own ride completion, and it comes back too.
          const truck = (room.uberMania.trucks ?? [])
            .find((t) => t.id === undo.truckId && t.player === seat);
          if (!truck) return;
          truck.spot = undo.prevSpot; // null sends an undone entry back off-board
          truck.facing = undo.prevFacing;
          ts.truck = undo.prevTurnTruck;
          ts.acted = false;
          ts.dicePool = undo.prevDicePool;
          if (Array.isArray(undo.prevRides)) player.rides = undo.prevRides;
          player.ridesCompleted = undo.prevRidesCompleted ?? player.ridesCompleted;
          room.uberMania.lastRoll = null;
        } else if (undo.kind === "time") {
          room.uberMania.time = undo.prevTime;
          room.uberMania.elapsed = Math.max(0, (room.uberMania.elapsed ?? 0) - undo.cost);
          player.timeStones += undo.cost;
          for (const oct of room.uberMania.map.intersections) {
            if (oct.number === undo.hour) oct.color = oct.color === "green" ? "red" : "green";
          }
          ts.changedTime = false;
        }
        ts.undo = null;
        emitState(roomId, room);
      });

      // Keep going: after movement has ended, take on one stress level (the
      // marker moves up the bar — one fewer safe number) to reopen movement
      // and another time change this turn. Not an option at max stress, and
      // never after a destress location — destressing forces the turn to end.
      socket.on("uber_mania_keep_going", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const ts = room.uberMania.turnState;
        if (!ts.acted || ts.destressed) return;
        const player = room.uberMania.players?.[seat];
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
      socket.on("uber_mania_end_turn", ({ roomId, hoodChoices } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        endTurnCore(roomId, seat, cleanHoodChoices(hoodChoices));
      });

      // Room-wide animation speed dial (×1 … ×3 in half steps).
      socket.on("uber_mania_set_speed", ({ roomId, speed } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const s = Number(speed);
        if (!Number.isFinite(s)) return;
        room.uberMania.speed = Math.min(3, Math.max(1, Math.round(s * 2) / 2));
        emitState(roomId, room);
      });
    }
  };
}
