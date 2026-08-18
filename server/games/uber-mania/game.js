// Uber Mania — the "Traffic Time" driving game about picking up passengers.
//
// The city core is shared with Truck Mania and Landmark Mania (../traffic-time):
// the same generated streets, the same numbered stop signs, the same clock you
// push forward with time stones, and a die banked for every red light you cross.
// Everything on top of that is this game's own.
//
// THE CITY is six DISTRICTS of seven locations each — 42 in all, under exactly
// 27 stop signs (24 numbered plus three that are always green), which between
// them have to cover the whole board. Every district wears one
// of the six player colors, and every player's car is painted the color of the
// district they live in — their HOME district. A district also belongs to one
// of the day's three sections: two are morning districts (schools, doctors,
// bakeries), two are work districts (offices, the foundry), two are evening
// districts (nightlife, restaurants). The clock runs 1am to 1am and a day is
// morning 1–8am, work 9am–4pm, evening 5pm–midnight.
//
// PASSENGERS come off two face-down piles. A tile's BACK shows two things: the
// color of the district it will send you to, and either a time-stone or a star
// symbol. Take it — that is your whole turn, instead of driving — and it flips
// over: now you can see the exact address. A time-stone tile pays 4 stones the
// moment you take it; a star tile pays a whole star when you finish the ride.
//
// THE PASSENGER BOARD is where the tiles land: numbers 2, 3, 4, 5 each in a
// square, and a bare 6 that nothing can ever cover. A new tile goes on the
// lowest free number, so a full car (four passengers) leaves only the 6
// showing. That is the whole risk system: when the dice come out for the red
// lights you ran, a die is safe only if its face is still SHOWING on your
// board. High rolls are good, an empty car is safe, and 1 is never safe.
// Every die that misses costs you half a star.
//
// ERRANDS are six chores you are dealt at the start, one in every district —
// a small circle of your color in the corner of a location.
// You collect one by parking there DURING that district's own section of the
// day. Anything still uncollected when the game ends is −2.
//
// SCORING. At the end of each day: a point per full star you hold, and one
// more if you are parked in your home district. At the end of the game: a
// point per completed ride, 2 for having driven a fare into all six districts,
// 2 for every non-home district you became a REGULAR in (three rides), and −2
// per errand left undone.
//
// ---------------------------------------------------------------------------
// STATIC MODE (`settings.mode === "static"`) is the same city and the same
// clock, with the dice — and everything that fed them — taken out:
//
//   * No dice at all. Every red light you run is a WHOLE star, flat. Harsh on
//     purpose: the clock is now the thing you spend stones on, because turning
//     a red green is worth far more than it was.
//   * Five passenger slots, and they are a QUEUE. The far left is the priority
//     fare: deliver that one and you gain a star. Deliver anyone else and you
//     drop half a star for every passenger you skipped over — everyone to their
//     left. After a delivery the rest slide left to close the gap, so a fare you
//     keep passing over keeps getting more expensive to leave.
//   * THREE piles of fourteen, gated by rating: the first is always open, the
//     second needs two stars, the third needs four. A pile is just a stack —
//     what it offers is whatever happens to be face down on top of it.
//   * Three kinds of passenger, an even mix. CHILL (⬟) pays six time stones the
//     moment you take them. TIP (🪙) is worth points at the end — your final
//     rating for each one delivered. RUSH (😡) lets you run one red for free on
//     the turn you drop them off.
//   * No errands and no home district. Every ride is 3 points, being a regular
//     (three rides) in ANY district is 5, and a fare into all six is 5.
//
// ---------------------------------------------------------------------------
// WAITING MODE (`settings.mode === "waiting"`) takes static's queue and scoring
// and changes what a red light IS. You cannot buy your way through one:
//
//   * You WAIT. A car may stop ON a red light — nose on the octagon — and on a
//     later turn drive straight through it. So a turn's drive ends either where
//     you choose or at the first red you meet, and the stop signs are drawn
//     bigger to hold a car. A RUSH passenger you deliver on the turn still lets
//     you sail through one. Nothing here costs a star: there is no toll.
//   * A route can call at address after address — stopping to collect an errand
//     doesn't stop the car — but DROPPING SOMEBODY OFF ends the drive, as does
//     a red light or your own choice.
//   * ERRANDS are back, dealt as in dice mode — one in every district,
//     collectable only during that district's own section of the day — and they
//     pay on a rising ladder: 2, 5, 8, 11, 15, 20 points for one through six, so
//     the whole set is 20 and half of it is 5. And running one with a full car
//     annoys everybody in it: half a star per passenger still riding.
//   * Your home district pays NOTHING here — it is only the color of your car.
//     You open with four time stones rather than ten, because the
//     clock is the only thing that turns a red green.
//   * The three passenger slots are a RIVER, not three piles: take the 0-star
//     one and the others slide down to fill the gap, with a fresh face-down
//     tile landing in the 4-star slot.
//   * One clock change a turn as ever — but here it can be spent on a turn you
//     took a passenger, not just on one you drove.
import {
  generateCityMap, randomizeOctagons, setBlankLights, deriveSpots, collectSegments
} from "../traffic-time/map.js";
import { buildStreetGraph, findPath, findRouteDirected } from "../traffic-time/routing.js";

// The clock opens at 1am, and a day runs 1am to 1am — the day counter ticks
// when the hand sweeps past 1am, which is exactly every 24 elapsed hours.
const START_TIME = 1;
const faceHour = (t) => ((t + 11) % 12) + 1;
const isNight = (t) => t >= 19 || t <= 6;

// The three sections of the day. Midnight is hour 0, and it belongs to the
// evening that ran into it — the new day starts at 1am. (Keep in sync with the
// client.)
const sectionOf = (t) => (t >= 1 && t <= 8 ? "morning" : t >= 9 && t <= 16 ? "work" : "evening");

// The six districts. Two per section, and the catalog order is fixed so a
// color always means the same neighbourhood — only WHERE on the map each one
// lands is shuffled from game to game. A player's car is painted their home
// district's color, so these double as the seat colors. The six hues are spread
// right around the wheel (gold, green, teal, blue, violet, magenta) and their
// values deliberately alternate, because the client washes each one out to tint
// a location's lot — colors any closer together than this stop telling the
// districts apart once they're that pale.
const DISTRICTS = [
  {
    key: "elmwood",
    name: "Elmwood",
    section: "morning",
    color: "#3f9c35",
    blurb: "Quiet streets, school runs and the first coffee of the day",
    places: [
      { name: "Bakery", emoji: "🥐" }, { name: "Dentist", emoji: "🦷" },
      { name: "Daycare", emoji: "🍼" }, { name: "Pharmacy", emoji: "💊" },
      { name: "Doctor", emoji: "🩺" }, { name: "Coffee Shop", emoji: "☕" },
      { name: "Corner Store", emoji: "🏪" }, { name: "Laundromat", emoji: "🧺" },
      { name: "Vet", emoji: "🐕" }, { name: "Post Office", emoji: "📮" },
      { name: "Bagel Counter", emoji: "🥯" }, { name: "Garden Centre", emoji: "🪴" }
    ]
  },
  {
    key: "fairview",
    name: "Fairview",
    section: "morning",
    color: "#2e5bd8",
    blurb: "Campus, classrooms and everything that starts before nine",
    places: [
      { name: "Elementary School", emoji: "🏫" }, { name: "High School", emoji: "🎒" },
      { name: "University", emoji: "🎓" }, { name: "Library", emoji: "📚" },
      { name: "Bookstore", emoji: "📖" }, { name: "Swim Lessons", emoji: "🏊" },
      { name: "Music Lessons", emoji: "🎻" }, { name: "Playground", emoji: "🎠" },
      { name: "Science Museum", emoji: "🔬" }, { name: "Art Class", emoji: "🎨" },
      { name: "Campus Café", emoji: "🥤" }, { name: "Lecture Hall", emoji: "🧑‍🏫" }
    ]
  },
  {
    key: "financial",
    name: "Financial District",
    section: "work",
    color: "#e5a51c",
    blurb: "Towers, meetings and the nine-to-four rush",
    places: [
      { name: "Bank", emoji: "🏦" }, { name: "Law Office", emoji: "⚖️" },
      { name: "City Hall", emoji: "🏛️" }, { name: "Insurance Tower", emoji: "🏢" },
      { name: "Newsroom", emoji: "📰" }, { name: "Consulting", emoji: "💼" },
      { name: "Courthouse", emoji: "🧑‍⚖️" }, { name: "Tax Office", emoji: "🧾" },
      { name: "Trading Floor", emoji: "📈" }, { name: "Conference Centre", emoji: "🎤" },
      { name: "Print Shop", emoji: "🖨️" }, { name: "Notary", emoji: "📝" }
    ]
  },
  {
    key: "foundry",
    name: "The Foundry",
    section: "work",
    color: "#8a4ad0",
    blurb: "Yards, docks and shift work",
    places: [
      { name: "Warehouse", emoji: "📦" }, { name: "Machine Shop", emoji: "🔧" },
      { name: "Auto Plant", emoji: "🚗" }, { name: "Loading Dock", emoji: "🚚" },
      { name: "Steel Mill", emoji: "🏭" }, { name: "Lumber Yard", emoji: "🪵" },
      { name: "Freight Depot", emoji: "🚛" }, { name: "Recycling Plant", emoji: "♻️" },
      { name: "Rail Yard", emoji: "🚂" }, { name: "Paint Works", emoji: "🖌️" },
      { name: "Tool Hire", emoji: "🪛" }, { name: "Power Station", emoji: "⚡" }
    ]
  },
  {
    key: "neon",
    name: "Neon Quarter",
    section: "evening",
    color: "#e3399b",
    blurb: "Where the night out happens",
    places: [
      { name: "Nightclub", emoji: "🪩" }, { name: "Jazz Bar", emoji: "🎷" },
      { name: "Cinema", emoji: "🎬" }, { name: "Theatre", emoji: "🎭" },
      { name: "Bowling Alley", emoji: "🎳" }, { name: "Arcade", emoji: "🕹️" },
      { name: "Karaoke", emoji: "🎙️" }, { name: "Pool Hall", emoji: "🎱" },
      { name: "Concert Hall", emoji: "🎸" }, { name: "Rooftop Bar", emoji: "🍸" },
      { name: "Casino", emoji: "🎰" }, { name: "Comedy Club", emoji: "🤹" }
    ]
  },
  {
    key: "riverside",
    name: "Riverside",
    section: "evening",
    color: "#16b8b0",
    blurb: "Dinner on the water",
    places: [
      { name: "Sushi Bar", emoji: "🍣" }, { name: "Pizzeria", emoji: "🍕" },
      { name: "Steakhouse", emoji: "🥩" }, { name: "Taco Stand", emoji: "🌮" },
      { name: "Noodle House", emoji: "🍜" }, { name: "Ice Cream Parlour", emoji: "🍦" },
      { name: "Wine Bar", emoji: "🍷" }, { name: "Seafood Grill", emoji: "🦐" },
      { name: "Ferry Terminal", emoji: "⛴️" }, { name: "Boardwalk", emoji: "🎡" },
      { name: "Marina", emoji: "⛵" }, { name: "Dessert Café", emoji: "🍰" }
    ]
  }
];

const DISTRICT_COUNT = DISTRICTS.length;
const MAX_SEATS = DISTRICT_COUNT; // one seat per district — your color is your home
const LOCS_PER_DISTRICT = 7;
const TOTAL_LOCATIONS = DISTRICT_COUNT * LOCS_PER_DISTRICT;

// The passenger board: squares over 2, 3, 4 and 5, and a bare 6 that nothing
// covers. Four passengers is a full car.
const BOARD_NUMBERS = [2, 3, 4, 5];
const FREE_NUMBER = 6;
const MAX_PASSENGERS = BOARD_NUMBERS.length;

// The star rating: whole and half stars, 0 to 5, opening on two.
const RATING_MAX = 5;
const RATING_START = 2;
const STAR_TILE_STEP = 1;    // a star passenger delivered
const FUN_STAR_STEP = 0.5;   // the fun die's other face
const FAIL_STAR_STEP = 0.5;  // per die that missed the board

const TILE_BONUSES = ["stones", "star"];
const STONE_TILE_REWARD = 4; // stones paid the moment a stone tile is taken
const FUN_STONE_REWARD = 2;  // the fun die's stone face

// Errands: one in every district, and each one still standing at the end costs
// this.
const ERRAND_PENALTY = 2;

// End-game bonuses.
const RIDE_POINTS = 1;
const ALL_DISTRICTS_BONUS = 2;
const REGULAR_RIDES = 3;      // rides in one district that make you a regular
const REGULAR_BONUS = 2;      // per non-home district you're a regular in

// --- Static mode ------------------------------------------------------------
// The passenger board is a four-deep QUEUE here, not numbered squares: slot 0
// is the priority fare and everything slides left behind a delivery.
const STATIC_SLOTS = 4;
const STATIC_PILE_SIZE = 14;
// What each of the three piles asks of your rating before it will deal to you.
const STATIC_PILE_RATING = [0, 2, 4];
// Waiting mode can lay its slots out two ways (`settings.slotRule`):
//   "two-four" — three slots at 0/2/4 stars, and taking one SLIDES the rest
//                down, so emptying the cheap slot is what feeds the dear ones
//   "three"    — two slots at 0 and 3 stars that don't slide at all; whichever
//                you take is refilled off the deck and the other is left alone
const THREE_PILE_RATING = [0, 3];
const SLOT_RULES = ["two-four", "three"];
// The three kinds of passenger, in an even mix through the whole deck.
const STATIC_TYPES = ["chill", "tip", "rush"];
const CHILL_STONES = 6;      // paid the moment a chill passenger is taken
const RED_STAR_COST = 1;     // a whole star per red light run — no dice, no mercy
const PRIORITY_STAR = 0.5;   // delivering the far-left fare (settings.priorityStar)
const SKIP_STAR_STEP = 0.5;  // per passenger you reached over to deliver
const STATIC_RIDE_POINTS = 3;
const STATIC_ALL_DISTRICTS_BONUS = 5;
const STATIC_REGULAR_BONUS = 5; // per district you're a regular in — home or not

// --- Waiting mode -----------------------------------------------------------
// Errands come back, but they pay on a rising ladder, and running one with
// people still in the car costs you half a star a head. Sleeping at home is
// worth half a star rather than a point.
const ERRAND_ANNOY_STEP = 0.5;
// What a finished set of errands pays, indexed by how many you collected. The
// steps grow (2, 3, 3, 3, 4, 5) so the set is worth committing to without the
// last one being worth a third of the game the way squaring made it.
const ERRAND_LADDER = [0, 2, 5, 8, 11, 15, 20];
const errandLadder = (n) =>
  ERRAND_LADDER[Math.max(0, Math.min(ERRAND_LADDER.length - 1, n))];
// Time stones are far tighter here: the clock is the ONLY way to turn a red
// green, and a red you can't turn green costs you a whole turn sitting on it.
const WAITING_START_STONES = 4;
// The 3★ layout only has two slots, and a table that opens at two stars would
// open with one of them shut — no choice at all on the first pickup. So that
// layout starts everyone level with its gate.
const THREE_START_RATING = 3;

const MODES = ["dice", "static", "waiting"];

const BASE_SETTINGS = {
  // Waiting is the ruleset in play; dice and static are behind the Mode button.
  mode: "waiting",
  // PRE-TIME: when on, the clock is something you set BEFORE your turn rather
  // than during it — once you've driven or taken a passenger the hand is
  // locked. A table rule, not part of any one ruleset.
  preTime: true,
  // MULTI-MOVE: when on, dropping someone off or running an errand no longer
  // ends the drive — only a red light does. Nothing else about them changes.
  multiMove: false,
  // Which slot layout waiting mode deals — see THREE_PILE_RATING.
  slotRule: "two-four",
  // What delivering the FRONT of the queue pays: half a star, or a whole one.
  priorityStar: PRIORITY_STAR,
  days: 3,
  startingTimeStones: 10,
  startingRating: RATING_START,
  ratingMax: RATING_MAX,
  tilesPerDistrict: 8,       // 48 tiles, dealt evenly into the two piles
  stoneTileReward: STONE_TILE_REWARD,
  funStoneReward: FUN_STONE_REWARD,
  errandPenalty: ERRAND_PENALTY,
  ridePoints: RIDE_POINTS,
  allDistrictsBonus: ALL_DISTRICTS_BONUS,
  regularBonus: REGULAR_BONUS,
  blankLights: { green: 3, red: 0 }
};

const cloneSettings = (s) => JSON.parse(JSON.stringify(s));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const k = Math.floor(Math.random() * (i + 1));
    [a[i], a[k]] = [a[k], a[i]];
  }
  return a;
}

const freshTurnState = () => ({
  acted: false,       // movement is over (the car parked, or a tile was taken)
  carryOn: false,     // multi-move: that stop completed something, drive on
  changedTime: false, // the clock moves once a turn
  drew: false,        // the turn was spent taking a passenger tile
  truck: null,        // the car locked in as this turn's mover
  dicePool: 0,        // a die per red light crossed, rolled when the turn ends
  // One-step undo: the turn's latest still-revocable action.
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

// Split the chosen locations into six geographically coherent districts:
// columns sliced along x, each column split along y. District ids run 0..5.
function partitionDistricts(locations, k) {
  const n = locations.length;
  const sizes = Array.from({ length: k }, (_, i) =>
    Math.floor(n / k) + (i < n % k ? 1 : 0));
  const sorted = locations
    .map((b) => ({ b, c: buildingCentroid(b) }))
    .sort((p, q) => p.c[0] - q.c[0]);
  let cursor = 0;
  let district = 0;
  while (district < k) {
    const colDistricts = Math.min(2, k - district);
    let colN = 0;
    for (let j = 0; j < colDistricts; j += 1) colN += sizes[district + j];
    const col = sorted.slice(cursor, cursor + colN).sort((p, q) => p.c[1] - q.c[1]);
    cursor += colN;
    let inner = 0;
    for (let j = 0; j < colDistricts; j += 1) {
      for (let m = 0; m < sizes[district + j]; m += 1) {
        col[inner].b.district = district + j;
        inner += 1;
      }
    }
    district += colDistricts;
  }
}

// Deal the board: pick the reachable buildings, carve them into six districts,
// and give every location the name and picture of whichever district it landed
// in. Returns the district list (id -> catalog entry), shuffled so the same
// neighbourhood turns up somewhere new every game.
function assignLocations(map) {
  const buildings = (map.blocks ?? []).flatMap((b) => b.buildings ?? []);
  buildings.forEach((b) => {
    b.role = "empty";
    b.color = "#f4f1ea";
    delete b.district;
    delete b.name;
    delete b.emoji;
    delete b.errands;
  });

  // trimMap already cut the board down to exactly the lots the deal seats, so
  // every one of them becomes a location.
  const picked = buildings.filter((b) => (b.connectors ?? []).length > 0);
  partitionDistricts(picked, DISTRICT_COUNT);

  // Which catalog entry each geographic district id becomes.
  const order = shuffle(DISTRICTS.map((_, i) => i));
  const districts = order.map((catalogIdx, id) => ({
    id,
    ...DISTRICTS[catalogIdx]
  }));

  const nameCursor = districts.map(() => 0);
  picked.forEach((b) => {
    const d = districts[b.district];
    b.role = "loc";
    b.color = d.color;
    b.errands = [];
    const pool = d.places;
    const i = nameCursor[b.district];
    nameCursor[b.district] += 1;
    const place = pool[i % pool.length];
    const lap = Math.floor(i / pool.length);
    b.name = lap ? `${place.name} ${lap + 1}` : place.name;
    b.emoji = place.emoji;
  });
  return districts.map(({ id, key, name, section, color, blurb }) =>
    ({ id, key, name, section, color, blurb }));
}

function buildingByBid(map, bid) {
  for (const block of map.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      if (b.bid === bid) return b;
    }
  }
  return null;
}

function allLocations(map) {
  const out = [];
  for (const block of map.blocks ?? []) {
    for (const b of block.buildings ?? []) {
      if (b.role === "loc") out.push(b);
    }
  }
  return out;
}

const humanCount = (room) => Math.max(1, new Set(room.players ?? []).size);
const maxAiFor = (room) => MAX_SEATS - humanCount(room);

export function createUberManiaGame({ io, rooms }) {
  const S = (room) => room.uberMania.settings ?? BASE_SETTINGS;

  // The branches everything else hangs off. All three modes share the city, the
  // clock and the cars. STATIC and WAITING share the four-deep queue, the three
  // passenger kinds and the scoring — `queueMode` is the test for "the static
  // family". DICE and WAITING share the errands. Only waiting mode changes what
  // a red light means.
  const modeOf = (room) => S(room).mode ?? "dice";
  const isStatic = (room) => modeOf(room) === "static";
  const isWaiting = (room) => modeOf(room) === "waiting";
  const queueMode = (room) => modeOf(room) !== "dice";
  const hasErrands = (room) => modeOf(room) !== "static";
  const slotCount = (room) => (queueMode(room) ? STATIC_SLOTS : MAX_PASSENGERS);
  // What the piles ask of your rating, and — the other half of the same rule —
  // how many of them there are. Only waiting mode offers the choice; static's
  // three standing piles are cut from the deck and can't be re-laid.
  const pileGates = (room) =>
    (isWaiting(room) && S(room).slotRule === "three" ? THREE_PILE_RATING : STATIC_PILE_RATING);
  // Does taking a slot pull the others down after it?
  const riverSlides = (room) => S(room).slotRule !== "three";
  // What everyone opens on, and what the front of the queue pays. Both are the
  // table's to set; the 3★ layout nudges the opening rating up to its gate when
  // it's dealt, rather than overriding the choice here.
  const startingRating = (room) => clampRating(room, S(room).startingRating ?? RATING_START);
  const priorityStar = (room) => {
    const v = Number(S(room).priorityStar);
    return Number.isFinite(v) && v > 0 ? v : PRIORITY_STAR;
  };
  const clampRating = (room, v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return RATING_START;
    const cap = S(room).ratingMax ?? RATING_MAX;
    return Math.max(0, Math.min(cap, Math.round(n * 2) / 2));
  };

  // May this player still move the hand? One change a turn either way; waiting
  // mode lets it share a turn with taking a passenger; and PRE-TIME, when on,
  // demands it happen before anything else the turn does.
  function clockAllowed(room) {
    const ts = room.uberMania.turnState;
    if (!ts || ts.changedTime) return false;
    if (ts.drew && !isWaiting(room)) return false;
    if (S(room).preTime && ts.acted) return false;
    return true;
  }

  // ---- Board setup ---------------------------------------------------------

  // Exactly 24 numbered stop signs plus three that are always green: 27 lights,
  // and between them they have to reach the whole city — which is what keeps
  // the board small enough that 42 locations fill it.
  const LIGHT_COUNT = 24 + BASE_SETTINGS.blankLights.green + BASE_SETTINGS.blankLights.red;

  function genOpts() {
    // The generator only lands NEAR the building count it's asked for, and a
    // lot with no driveway can never be a location — so ask a little over the
    // 42 the deal seats and trim the surplus off afterwards.
    return {
      dense: false,
      buildings: TOTAL_LOCATIONS + 2,
      intersections: LIGHT_COUNT,
      packed: true
    };
  }

  // A map that seats the whole deal with as little slack as possible: six
  // districts of seven is exact, so a board that came up short would deal
  // lopsided districts, and one that came up long leaves gaps where the
  // surplus lots were trimmed. Keep the closest fit from above.
  function makeMap() {
    let best = null;
    let bestSeats = Infinity;
    for (let tries = 0; tries < 12; tries += 1) {
      const map = generateCityMap(Date.now() + tries * 7919, genOpts());
      const seats = (map.blocks ?? []).flatMap((bl) => bl.buildings ?? [])
        .filter((b) => (b.connectors ?? []).length > 0).length;
      if (seats < TOTAL_LOCATIONS) continue;
      if (seats < bestSeats) {
        best = map;
        bestSeats = seats;
      }
      if (seats === TOTAL_LOCATIONS) break;
    }
    const map = best ?? generateCityMap(Date.now(), genOpts());
    trimMap(map);
    return map;
  }

  // Cut the map down to exactly the lots the deal will use: no driveway-less
  // buildings, no surplus. Every lot left standing becomes a location, so the
  // board never carries a blank one. The surplus comes off the fullest blocks
  // first — the survivors stay spread over the whole city, and the gaps read
  // as the odd bit of open ground rather than a hole in one neighbourhood.
  function trimMap(map) {
    const blocks = map.blocks ?? [];
    for (const bl of blocks) {
      bl.buildings = (bl.buildings ?? []).filter((b) => (b.connectors ?? []).length > 0);
    }
    let total = blocks.reduce((n, bl) => n + bl.buildings.length, 0);
    while (total > TOTAL_LOCATIONS) {
      let fullest = null;
      for (const bl of blocks) {
        if (bl.buildings.length < 2) continue; // never empty a block out
        if (!fullest || bl.buildings.length > fullest.buildings.length) fullest = bl;
      }
      if (!fullest) break;
      // Drop the smallest lot in it — the one least missed.
      const area = (b) => (b.points ? 0 : (b.w ?? 0) * (b.h ?? 0));
      let worst = 0;
      fullest.buildings.forEach((b, i) => {
        if (area(b) < area(fullest.buildings[worst])) worst = i;
      });
      fullest.buildings.splice(worst, 1);
      total -= 1;
    }
    map.blocks = blocks.filter((bl) => bl.buildings.length);
    map.spots = deriveSpots(map); // bids are re-dealt over what's left
    spreadSpots(map);
    return total;
  }

  // A parking space sits where its driveway meets the street, and that is
  // sometimes underneath a stop sign or on top of the space next door — either
  // way it can't be clicked. Slide the offenders ALONG their own street until
  // they're clear, which keeps them kerbside and keeps the route graph honest.
  // Uses waiting mode's bigger sign radius throughout, so a map stays playable
  // when the table switches rulesets without regenerating.
  //
  // A space is ONLY routable while it lies on a street segment: `buildStreetGraph`
  // gives a space a node of its own only when it projects to within 5px of the
  // centreline, and the client then matches node to space within 8px. Move one
  // even slightly off the line and it still draws — as a ring you cannot click,
  // because it is in nobody's choice list. So every candidate position here is
  // a point ON the space's own segment, and nowhere else.
  const SPOT_R = 11;        // the clickable ring the client draws
  const OCT_R_MAX = 19;     // the largest a stop sign is ever drawn
  const SEG_INSET = 4;      // never slide right into the junction at either end
  function spreadSpots(map) {
    const spots = map.spots ?? [];
    const octs = map.intersections ?? [];
    const segs = collectSegments(map.streets ?? []);
    // The segment each space belongs to, and where along it the space sits.
    const home = spots.map((s) => {
      let best = null;
      let bd = Infinity;
      for (const g of segs) {
        const pr = projectToSegment(s.x, s.y, g[0], g[1], g[2], g[3]);
        if (pr.dist < bd) {
          bd = pr.dist;
          best = g;
        }
      }
      if (!best) return null;
      const len = Math.hypot(best[2] - best[0], best[3] - best[1]);
      if (len < 1) return null;
      const pr = projectToSegment(s.x, s.y, best[0], best[1], best[2], best[3]);
      return {
        x0: best[0], y0: best[1],
        ux: (best[2] - best[0]) / len,
        uy: (best[3] - best[1]) / len,
        len,
        at: pr.t * len
      };
    });
    // Sit every space exactly on its own segment before anything else: a space
    // the generator left a pixel or two off the line is already unclickable.
    spots.forEach((s, i) => {
      const h = home[i];
      if (!h) return;
      s.x = h.x0 + h.ux * h.at;
      s.y = h.y0 + h.uy * h.at;
    });
    const octClear = OCT_R_MAX + SPOT_R; // full clearance: the rings can't touch
    const spotClear = SPOT_R * 2;
    const STEP = 3;
    const REACH = 36; // further than this and it stops being this lot's kerb
    // A penalty, zero when a position is perfectly clear. The two constraints
    // are NOT equal: a space under a stop sign can't be clicked at all, while
    // two spaces a little too close are merely snug and both still hittable —
    // so overlapping a sign is weighted far heavier and wins every trade.
    const SIGN_WEIGHT = 4;
    const score = (x, y, self) => {
      let sign = Infinity;
      let near = Infinity;
      for (const o of octs) sign = Math.min(sign, Math.hypot(o.x - x, o.y - y) - octClear);
      for (let j = 0; j < spots.length; j += 1) {
        if (j === self) continue;
        near = Math.min(near, Math.hypot(spots[j].x - x, spots[j].y - y) - spotClear);
      }
      return Math.min(sign, 0) * SIGN_WEIGHT + Math.min(near, 0);
    };
    // Several passes: moving one space to clear a sign can crowd its neighbour,
    // and the neighbour only gets to answer on the pass after.
    for (let pass = 0; pass < 3; pass += 1) {
      spots.forEach((s, i) => {
        const h = home[i];
        if (!h) return;
        let best = { at: h.at, v: score(s.x, s.y, i) };
        if (best.v === 0) return;
        // Walk the segment either way from where the driveway meets it. Every
        // candidate stays ON the line, so the space keeps its graph node.
        const lo = Math.min(SEG_INSET, h.len / 2);
        const hi = Math.max(lo, h.len - SEG_INSET);
        for (let d = STEP; d <= REACH && best.v < 0; d += STEP) {
          for (const dir of [1, -1]) {
            const at = Math.max(lo, Math.min(hi, h.at + d * dir));
            const v = score(h.x0 + h.ux * at, h.y0 + h.uy * at, i);
            if (v > best.v) best = { at, v };
          }
        }
        // Even when nothing along this kerb is perfectly clear, take the
        // roomiest place there is — leaving it where it started is how a space
        // ends up buried under a stop sign and unclickable.
        h.at = best.at;
        s.x = h.x0 + h.ux * best.at;
        s.y = h.y0 + h.uy * best.at;
      });
    }
  }

  // The passenger deck: `tilesPerDistrict` tiles for every district, half of
  // them time-stone tiles and half star tiles, shuffled and cut into two piles.
  // A tile only carries its district and its symbol — the exact address is
  // rolled when it's taken and flipped.
  function buildPiles(settings) {
    const per = Math.max(2, settings.tilesPerDistrict ?? 8);
    const deck = [];
    for (let d = 0; d < DISTRICT_COUNT; d += 1) {
      for (let i = 0; i < per; i += 1) {
        deck.push({ district: d, bonus: TILE_BONUSES[i % TILE_BONUSES.length] });
      }
    }
    const mixed = shuffle(deck);
    const half = Math.ceil(mixed.length / 2);
    return [mixed.slice(0, half), mixed.slice(half)];
  }

  // The 42 passengers the queue modes share: an even split three ways by kind
  // and six ways by district, shuffled. Static cuts this into three standing
  // piles; waiting mode keeps it as one deck feeding three slots. Either way
  // what you get to see is a back, and nothing about a slot predicts it.
  function buildQueueDeck() {
    const total = STATIC_PILE_SIZE * STATIC_PILE_RATING.length;
    // Districts and kinds are shuffled SEPARATELY before being paired up: 42
    // divides by both 6 and 3, so walking one counter through both would make
    // every district a single kind of passenger.
    const districts = shuffle(Array.from({ length: total }, (_, i) => i % DISTRICT_COUNT));
    const kinds = shuffle(Array.from({ length: total },
      (_, i) => STATIC_TYPES[i % STATIC_TYPES.length]));
    return districts.map((district, i) => ({ district, bonus: kinds[i] }));
  }

  // Six errands per player: one location in every district, home included.
  // Locations are handed out without replacement, so two players never share a
  // corner (a district has seven locations and at most six players needing one
  // there).
  function dealErrands(room) {
    const map = room.uberMania.map;
    const byDistrict = new Map();
    for (const b of allLocations(map)) {
      b.errands = [];
      if (!byDistrict.has(b.district)) byDistrict.set(b.district, []);
      byDistrict.get(b.district).push(b);
    }
    const pools = new Map();
    for (const [d, list] of byDistrict) pools.set(d, shuffle(list));
    (room.uberMania.players ?? []).forEach((p, seat) => {
      p.errands = [];
      for (let d = 0; d < DISTRICT_COUNT; d += 1) {
        const pool = pools.get(d) ?? [];
        const b = pool.pop();
        if (!b) continue;
        b.errands.push(seat);
        p.errands.push(b.bid);
      }
    });
  }

  // Deal a fresh board: locations, districts, homes, errands, piles, cars.
  // Humans hold the first seats and AI fill in behind, up to six.
  function setupBoard(room) {
    const settings = S(room);
    const humans = humanCount(room);
    const maxAi = maxAiFor(room);
    const aiCount = Math.max(0, Math.min(maxAi, room.uberMania.aiCount ?? Math.min(maxAi, 3)));
    room.uberMania.aiCount = aiCount;
    const seats = humans + aiCount;

    room.uberMania.districts = assignLocations(room.uberMania.map);
    setBlankLights(
      room.uberMania.map.intersections,
      settings.blankLights?.green ?? 6,
      settings.blankLights?.red ?? 6
    );

    // Home districts: a shuffled deal, so the seat you take doesn't decide the
    // neighbourhood you live in.
    const homes = shuffle(room.uberMania.districts.map((d) => d.id)).slice(0, seats);

    room.uberMania.trucks = Array.from({ length: seats }, (_, i) => ({
      id: i, player: i, spot: null, light: null, facing: 0
    }));
    room.uberMania.players = room.uberMania.trucks.map((t, i) => {
      // Static mode has no home district — the deal still hands out one per
      // seat, but only to decide what color the car is painted.
      const home = homes[i];
      return {
        home,
        color: room.uberMania.districts[home].color,
        name: i >= humans ? `AI ${i - humans + 1}` : humans === 1 ? "You" : `P${i + 1}`,
        isAI: i >= humans,
        timeStones: isWaiting(room) ? WAITING_START_STONES : settings.startingTimeStones,
        rating: startingRating(room),
        points: 0,             // banked at each day's end
        passengers: [],        // { id, slot, district, bonus, loc, done }
        ridesCompleted: 0,
        ridesByDistrict: Array.from({ length: DISTRICT_COUNT }, () => 0),
        errands: [],           // bids still to collect (dice mode only)
        errandsDone: 0,
        starsLost: 0,          // stars docked by reds, for the final chart
        homeNights: 0,         // days ended parked at home, for the chart
        tipsDelivered: 0,      // queue modes: each is worth your final rating
        redsRun: 0,            // static: reds actually charged for, for the chart
        skipped: 0,            // queue modes: passengers reached over
        annoyed: 0,            // waiting: passengers dragged along on an errand
        redsWaited: 0,         // waiting: turns that ended sat at a red
        clockChanges: 0,       // times this driver moved the hand
        stonesSpent: 0         // stones burned on the clock, all game
      };
    });

    if (hasErrands(room)) {
      dealErrands(room);
    } else {
      for (const b of allLocations(room.uberMania.map)) b.errands = [];
    }
    if (queueMode(room)) {
      // Static deals three standing piles; waiting mode deals a RIVER — three
      // face-down slots fed by one shared deck.
      const deck = buildQueueDeck();
      if (isWaiting(room)) {
        room.uberMania.deck = deck;
        room.uberMania.piles = pileGates(room).map(() => (deck.length ? [deck.shift()] : []));
      } else {
        room.uberMania.deck = null;
        room.uberMania.piles = STATIC_PILE_RATING.map((_, i) =>
          deck.slice(i * STATIC_PILE_SIZE, (i + 1) * STATIC_PILE_SIZE));
      }
    } else {
      room.uberMania.deck = null;
      room.uberMania.piles = buildPiles(settings);
    }
    room.uberMania.tileSeq = 0;
    room.uberMania.time = START_TIME;
    room.uberMania.elapsed = 0;
    room.uberMania.pendingDay = 0;
    room.uberMania.turn = 0;
    room.uberMania.turnState = freshTurnState();
    room.uberMania.lastRoll = null;
    room.uberMania.lastToll = null;
    room.uberMania.funRoll = null;
    room.uberMania.winner = null;
    room.uberMania.results = null;
    room.uberMania.aiGraph = null;
    room.uberMania.aiMove = null;
    room.uberMania.snapCar = null;
  }

  // ---- The clock and the day -----------------------------------------------

  // The clock only runs forward, and the game opens at 1am — so a day ends
  // (midnight rolls into 1am) exactly when `elapsed` crosses a multiple of 24.
  // The hand and the board move at once; the day's PAYOUT waits until the
  // player who pushed the clock over finishes their turn, so nobody is punished
  // for being the one to end the day.
  function runClock(room, hours) {
    const before = room.uberMania.elapsed ?? 0;
    const after = before + Math.max(0, hours);
    room.uberMania.elapsed = after;
    room.uberMania.time = (((room.uberMania.time ?? START_TIME) + Math.max(0, hours)) % 24 + 24) % 24;
    const days = Math.floor(after / 24) - Math.floor(before / 24);
    if (days > 0) room.uberMania.pendingDay = (room.uberMania.pendingDay ?? 0) + days;
    return days;
  }

  // Every clock change goes through here so the end-of-game stats can't drift
  // from what actually happened: the stones leave the player, the hand moves,
  // and both are counted once.
  function spendClock(room, player, cost) {
    player.timeStones -= cost;
    player.stonesSpent = (player.stonesSpent ?? 0) + cost;
    player.clockChanges = (player.clockChanges ?? 0) + 1;
    runClock(room, cost);
  }

  function settleDay(room) {
    const owed = room.uberMania.pendingDay ?? 0;
    if (owed <= 0) return;
    room.uberMania.pendingDay = 0;
    for (let n = 0; n < owed; n += 1) endOfDay(room);
  }

  // A day's wages: a point per FULL star, and one more for sleeping in your
  // own district (the car parked at a home-district location). Waiting mode
  // pays neither — your rating is worth points there only through tips.
  function endOfDay(room) {
    if (isWaiting(room)) return;
    (room.uberMania.players ?? []).forEach((p, seat) => {
      p.points = (p.points ?? 0) + Math.floor(p.rating ?? 0);
      if (isStatic(room)) return; // no home district to sleep in
      const truck = (room.uberMania.trucks ?? []).find((t) => t.player === seat);
      // Sitting on a red light is not sleeping at home — you have to be parked
      // at an address in your own district.
      const b = truck && truck.spot != null ? buildingAtTruck(room, truck) : null;
      if (!b || b.district !== p.home) return;
      // Waiting mode pays nothing for sleeping at home — your home district is
      // only the color of your car there.
      if (isWaiting(room)) return;
      p.homeNights = (p.homeNights ?? 0) + 1;
      p.points += 1;
    });
  }

  // ---- Passenger board -----------------------------------------------------

  // The numbers still visible on a player's board: the free 6, plus any of
  // 2–5 that no tile is sitting on. A die is safe if its face is one of these.
  function showingNumbers(player) {
    const covered = new Set((player.passengers ?? []).map((t) => BOARD_NUMBERS[t.slot]));
    const out = BOARD_NUMBERS.filter((n) => !covered.has(n));
    out.push(FREE_NUMBER);
    return out;
  }

  // Where the next passenger lands, or -1 when the car is full. Dice mode fills
  // the lowest empty SQUARE; static mode's board is a queue, so a new fare joins
  // the back of it and the priority stays whoever has been waiting longest.
  function lowestFreeSlot(room, player) {
    const held = player.passengers ?? [];
    if (queueMode(room)) return held.length < STATIC_SLOTS ? held.length : -1;
    const used = new Set(held.map((t) => t.slot));
    for (let i = 0; i < MAX_PASSENGERS; i += 1) {
      if (!used.has(i)) return i;
    }
    return -1;
  }

  // Can this driver deal from this slot at all? The gates are the slot rule's
  // half of the bargain — 0/2/4 stars across three, or 0/3 across two.
  function pileLocked(room, player, pileIdx) {
    if (!queueMode(room)) return false;
    return (player?.rating ?? 0) < (pileGates(room)[pileIdx] ?? 0);
  }

  // Waiting mode's river: taking a slot pulls everything above it DOWN one and
  // deals a fresh face-down tile into the four-star slot. So emptying the cheap
  // slot is what feeds the expensive one — the table refills itself, and taking
  // the top slot moves nothing. Under the 3-star rule nothing slides: the slot
  // you took is refilled where it stands and the other is left exactly as it
  // was, so the dear slot's tile sits there until somebody can afford it.
  function slideRiver(room, taken) {
    const piles = room.uberMania.piles ?? [];
    const deck = room.uberMania.deck ?? [];
    if (!riverSlides(room)) {
      piles[taken] = deck.length ? [deck.shift()] : [];
      return;
    }
    for (let i = taken; i < piles.length - 1; i += 1) piles[i] = piles[i + 1];
    piles[piles.length - 1] = deck.length ? [deck.shift()] : [];
  }

  // Take the top tile off a pile: it flips over, an address in its district is
  // rolled, and it lands on the lowest free number. A time-stone tile pays out
  // right now; a star tile pays when the fare is delivered.
  function drawTileCore(room, seat, pileIdx) {
    const ts = room.uberMania.turnState;
    // Waiting mode lets the clock and a passenger share a turn; the other two
    // make you choose.
    if (ts.acted || ts.truck != null || (ts.changedTime && !isWaiting(room))) return false;
    if (room.uberMania.winner != null) return false;
    const player = room.uberMania.players?.[seat];
    const pile = room.uberMania.piles?.[pileIdx];
    if (!player || !Array.isArray(pile) || !pile.length) return false;
    if (pileLocked(room, player, pileIdx)) return false;
    const slot = lowestFreeSlot(room, player);
    if (slot < 0) return false;

    const tile = pile.shift();
    // The address: somewhere in the tile's district that this driver isn't
    // already booked for, and — where there's a choice — not the kerb they're
    // parked at, so a fare is always a trip.
    const held = new Set((player.passengers ?? []).map((t) => t.loc));
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === seat);
    const parkedBid = truck && truck.spot != null ? buildingAtTruck(room, truck)?.bid : null;
    const inDistrict = allLocations(room.uberMania.map).filter((b) => b.district === tile.district);
    const free = inDistrict.filter((b) => !held.has(b.bid));
    const away = free.filter((b) => b.bid !== parkedBid);
    const pool = away.length ? away : free.length ? free : inDistrict;
    const target = pool[Math.floor(Math.random() * pool.length)];
    if (!target) {
      pile.unshift(tile); // nowhere to send them — put the tile back
      return false;
    }

    room.uberMania.tileSeq = (room.uberMania.tileSeq ?? 0) + 1;
    player.passengers.push({
      id: `t${room.uberMania.tileSeq}`,
      slot,
      district: tile.district,
      bonus: tile.bonus,
      loc: target.bid,
      done: false
    });
    if (tile.bonus === "stones") {
      player.timeStones = (player.timeStones ?? 0) + (S(room).stoneTileReward ?? STONE_TILE_REWARD);
    } else if (tile.bonus === "chill") {
      player.timeStones = (player.timeStones ?? 0) + CHILL_STONES;
    }
    if (isWaiting(room)) slideRiver(room, pileIdx);
    ts.acted = true;
    ts.drew = true;
    ts.undo = null; // a flipped tile can't be un-seen
    return true;
  }

  // ---- Arriving somewhere --------------------------------------------------

  function buildingAtTruck(room, truck) {
    const spot = room.uberMania.map.spots?.[truck.spot];
    return spot ? buildingByBid(room.uberMania.map, spot.building) : null;
  }

  // Parking at an address does two things at once, and both are automatic:
  // every passenger bound for it is DELIVERED (the tile stays on the board
  // covering its number until the dice have been rolled — that's the point of
  // the rule), and an errand of yours sitting here is collected, but only
  // during that district's own section of the day.
  function resolveArrival(room, truck, player, seat, bArg = null) {
    const b = bArg ?? buildingAtTruck(room, truck);
    if (!b || b.role !== "loc") return;
    for (const t of player.passengers ?? []) {
      if (t.loc === b.bid) t.done = true;
    }
    const district = room.uberMania.districts?.[b.district];
    const now = sectionOf(room.uberMania.time ?? START_TIME);
    if (district && district.section === now && (b.errands ?? []).includes(seat)) {
      b.errands = b.errands.filter((s) => s !== seat);
      player.errands = (player.errands ?? []).filter((bid) => bid !== b.bid);
      player.errandsDone = (player.errandsDone ?? 0) + 1;
      // Waiting mode: running your own errand with people still in the car is
      // exactly as rude as it sounds — half a star each. Counted AFTER the
      // deliveries above, so anyone you just dropped off here doesn't mind.
      if (isWaiting(room)) {
        const riding = (player.passengers ?? []).filter((t) => !t.done).length;
        if (riding > 0) {
          const wanted = riding * ERRAND_ANNOY_STEP;
          player.starsLost = (player.starsLost ?? 0) + Math.min(player.rating ?? 0, wanted);
          player.rating = Math.max(0, (player.rating ?? 0) - wanted);
          player.annoyed = (player.annoyed ?? 0) + riding;
        }
      }
    }
  }

  // Re-check whatever the parked car is sitting on. Called after a clock
  // change: pushing the hand into a district's own section opens the errand
  // waiting under your wheels, which is a real (and expensive) way to collect
  // one — wait it out rather than drive back later.
  function resolveParked(room, seat) {
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === seat);
    const player = room.uberMania.players?.[seat];
    if (!truck || !player || truck.spot == null) return;
    resolveArrival(room, truck, player, seat);
  }

  // Put back an errand token an undone action had collected.
  function restoreErrands(room, seat, prevErrands) {
    const player = room.uberMania.players?.[seat];
    if (!player || !Array.isArray(prevErrands)) return;
    for (const bid of prevErrands) {
      if ((player.errands ?? []).includes(bid)) continue;
      const b = buildingByBid(room.uberMania.map, bid);
      if (b && !(b.errands ?? []).includes(seat)) (b.errands ??= []).push(seat);
    }
    player.errands = prevErrands.slice();
  }

  // Park the car and bank a die per red light crossed (rolled at turn end).
  function applyMove(room, truck, spot, reds) {
    truck.spot = spot;
    truck.light = null;
    const seat = truck.player;
    const player = room.uberMania.players?.[seat];
    const n = Number.isInteger(reds) ? Math.max(0, Math.min(12, reds)) : 0;
    const ts = room.uberMania.turnState;
    ts.dicePool = Math.min(12, (ts.dicePool ?? 0) + n);
    ts.acted = true;
    ts.truck = truck.id;
    room.uberMania.lastRoll = null;
    if (player) resolveArrival(room, truck, player, seat);
  }

  // Waiting mode's drive. A route can call at addresses on the way — stopping to
  // collect an errand doesn't stop the car — but a DROP-OFF does: the moment a
  // passenger gets out, that's where the turn's driving ends. Otherwise the
  // route finishes where you chose or with its nose on a red light, which is
  // where it sits until a later turn drives straight through. Nothing here banks
  // dice: you can't buy your way past a red, so there's no bill at the end.
  function applyWaitMove(room, truck, { spot = null, light = null, visited = [], facing = null }) {
    const seat = truck.player;
    const player = room.uberMania.players?.[seat];
    const map = room.uberMania.map;
    const ts = room.uberMania.turnState;
    // Every kerb the route called at, in order, then wherever it stopped.
    const calls = [...visited];
    if (spot != null) calls.push(spot);
    let endSpot = spot;
    let endLight = light;
    // Did the place the car actually STOPPED at complete something? Under
    // multi-move that's what buys another move this turn.
    let finished = false;
    if (player) {
      for (const idx of calls) {
        const s = (map.spots ?? [])[idx];
        const b = s ? buildingByBid(map, s.building) : null;
        if (!b) continue;
        const drops = (player.passengers ?? []).some((t) => !t.done && t.loc === b.bid);
        const errandsBefore = player.errandsDone ?? 0;
        resolveArrival(room, truck, player, seat, b);
        const ranErrand = (player.errandsDone ?? 0) > errandsBefore;
        const did = drops || ranErrand;
        finished = did && idx === calls[calls.length - 1];
        // Under multi-move a stop is never the end of anything: the route runs
        // to wherever the driver aimed it and every call along the way lands.
        if (did && !S(room).multiMove) {
          // The rest of the route never happens — you stopped to do something.
          // Pulling in anywhere else is just a pause and the car drives on.
          endSpot = idx;
          endLight = null;
          break;
        }
      }
    }
    truck.spot = endSpot;
    truck.light = endLight;
    // The heading a car finished on MATTERS here in a way it never did before:
    // a car waiting at a light is drawn backed up along it, and next turn it
    // pulls away along it too. Nothing else on the board records it — a kerb
    // has its own angle — so if the mover didn't report one, keep the old.
    if (Number.isFinite(facing)) truck.facing = facing;
    if (endLight != null && player) player.redsWaited = (player.redsWaited ?? 0) + 1;
    ts.acted = true;
    // MULTI-MOVE: dropping somebody off or running an errand doesn't end your
    // movement, so a drive that finishes on one leaves the turn open — park up,
    // let them out, and pull away again. Stopping anywhere else, or on a red,
    // is you choosing to stop, and that's the turn.
    ts.carryOn = finished && !!S(room).multiMove && endLight == null;
    ts.truck = truck.id;
    room.uberMania.lastRoll = null;
  }

  // Where a car is standing, whichever kind of place that is.
  const carPlaced = (t) => t && (t.spot != null || t.light != null);
  // Kerbs are exclusive — a stop light isn't. Any number of cars can be held up
  // by the same red, and each one sits behind it on its own street.
  const spotTaken = (room, idx, exceptId = null) =>
    (room.uberMania.trucks ?? []).some((t) => t.id !== exceptId && t.spot === idx);

  // ---- End of turn ---------------------------------------------------------

  // The dice for the red lights you ran, thrown against the numbers still
  // showing on your passenger board. Every miss is half a star. This happens
  // BEFORE the delivered tiles come off, so a full car is a full car.
  function rollDice(room, seat) {
    const player = room.uberMania.players?.[seat];
    const ts = room.uberMania.turnState;
    const n = Math.max(0, Math.min(12, ts?.dicePool ?? 0));
    if (!player || n <= 0) {
      room.uberMania.lastRoll = null;
      return 0;
    }
    const showing = showingNumbers(player);
    const safe = new Set(showing);
    const dice = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
    const fails = dice.filter((d) => !safe.has(d)).length;
    const wanted = fails * FAIL_STAR_STEP;
    const lost = Math.min(player.rating ?? 0, wanted);
    player.rating = Math.max(0, (player.rating ?? 0) - wanted);
    player.starsLost = (player.starsLost ?? 0) + lost;
    room.uberMania.rollSeq = (room.uberMania.rollSeq || 0) + 1;
    room.uberMania.lastRoll = {
      seq: room.uberMania.rollSeq,
      player: seat,
      dice,
      showing,
      fails,
      lost
    };
    return fails > 0 ? DICE_MS_LOSS : DICE_MS_SAFE;
  }

  // Static mode's answer to the dice: no roll, just a bill. Every red light you
  // crossed is a whole star, except that each RUSH passenger you're dropping
  // off this turn waves one through. Charged before the fares get out, so the
  // rush tile is still on the board to pay for itself.
  function payRedToll(room, seat) {
    const player = room.uberMania.players?.[seat];
    const ts = room.uberMania.turnState;
    const reds = Math.max(0, Math.min(12, ts?.dicePool ?? 0));
    if (!player || reds <= 0) {
      room.uberMania.lastToll = null;
      return 0;
    }
    const forgiven = Math.min(
      reds,
      (player.passengers ?? []).filter((t) => t.done && t.bonus === "rush").length
    );
    const charged = reds - forgiven;
    const wanted = charged * RED_STAR_COST;
    const lost = Math.min(player.rating ?? 0, wanted);
    player.rating = Math.max(0, (player.rating ?? 0) - wanted);
    player.starsLost = (player.starsLost ?? 0) + lost;
    player.redsRun = (player.redsRun ?? 0) + charged;
    room.uberMania.tollSeq = (room.uberMania.tollSeq || 0) + 1;
    room.uberMania.lastToll = {
      seq: room.uberMania.tollSeq, player: seat, reds, forgiven, charged, lost
    };
    return charged > 0 ? TOLL_MS_LOSS : TOLL_MS_SAFE;
  }

  // The fun die: a driving turn that ran no reds at all gets this instead —
  // two time stones or half a star, an even chance either way.
  function rollFunDie(room, seat) {
    const player = room.uberMania.players?.[seat];
    if (!player) return 0;
    const face = TILE_BONUSES[Math.floor(Math.random() * TILE_BONUSES.length)];
    if (face === "stones") {
      player.timeStones = (player.timeStones ?? 0) + (S(room).funStoneReward ?? FUN_STONE_REWARD);
    } else {
      player.rating = Math.min(S(room).ratingMax ?? RATING_MAX, (player.rating ?? 0) + FUN_STAR_STEP);
    }
    room.uberMania.funSeq = (room.uberMania.funSeq || 0) + 1;
    room.uberMania.funRoll = { seq: room.uberMania.funSeq, player: seat, face };
    return FUN_DIE_MS;
  }

  // Now the delivered fares get out: the tiles come off the board, the rides
  // are tallied by district, and a star tile pays its whole star.
  function clearDeliveries(room, seat) {
    const player = room.uberMania.players?.[seat];
    if (!player) return;
    const done = (player.passengers ?? []).filter((t) => t.done);
    if (!done.length) return;
    const cap = S(room).ratingMax ?? RATING_MAX;
    const stat = queueMode(room);
    // Left to right, so a turn that somehow finished two fares charges the
    // skips in the order the queue actually stands.
    for (const t of done.sort((a, b) => a.slot - b.slot)) {
      player.ridesCompleted = (player.ridesCompleted ?? 0) + 1;
      player.ridesByDistrict[t.district] = (player.ridesByDistrict[t.district] ?? 0) + 1;
      if (!stat) {
        if (t.bonus === "star") {
          player.rating = Math.min(cap, (player.rating ?? 0) + STAR_TILE_STEP);
        }
        continue;
      }
      if (t.bonus === "tip") player.tipsDelivered = (player.tipsDelivered ?? 0) + 1;
      // Everyone still waiting to this fare's left is a passenger you reached
      // over: half a star each. Reach over nobody and you gain a whole one.
      const skipped = (player.passengers ?? [])
        .filter((o) => !o.done && o.slot < t.slot).length;
      if (skipped === 0) {
        player.rating = Math.min(cap, (player.rating ?? 0) + priorityStar(room));
      } else {
        const wanted = skipped * SKIP_STAR_STEP;
        player.starsLost = (player.starsLost ?? 0) + Math.min(player.rating ?? 0, wanted);
        player.rating = Math.max(0, (player.rating ?? 0) - wanted);
        player.skipped = (player.skipped ?? 0) + skipped;
      }
    }
    player.passengers = (player.passengers ?? []).filter((t) => !t.done);
    // The queue closes up behind a delivery.
    if (stat) {
      player.passengers
        .sort((a, b) => a.slot - b.slot)
        .forEach((t, i) => { t.slot = i; });
    }
  }

  // The shared end-of-turn path (humans and the AI alike): roll the banked
  // dice — or the fun die when a driving turn banked none — drop the delivered
  // fares, cash in any day the clock rolled past, then score the game or pass
  // the turn on.
  function endTurnCore(roomId, seat) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "uber-mania") return;
    const ts = room.uberMania.turnState;
    room.uberMania.funRoll = null;
    let rollMs = 0;
    if (queueMode(room)) {
      // No dice, and no fun die either. Static bills the reds it let you run;
      // waiting mode never banks any, so there is nothing to bill.
      room.uberMania.lastRoll = null;
      rollMs = payRedToll(room, seat);
    } else if ((ts?.dicePool ?? 0) > 0) {
      rollMs = rollDice(room, seat);
    } else {
      room.uberMania.lastRoll = null;
      // Only a turn actually spent on the road (or on the clock) earns the fun
      // die — taking a tile is its own reward.
      if (!ts?.drew && (ts?.truck != null || ts?.changedTime)) rollMs = rollFunDie(room, seat);
    }
    clearDeliveries(room, seat);
    settleDay(room);
    const endHours = (S(room).days ?? 3) * 24;
    if ((room.uberMania.elapsed ?? 0) >= endHours) {
      finalizeGame(room);
      clearAiTimer(roomId);
      emitState(roomId, room);
      return;
    }
    advanceTurn(roomId, rollMs);
  }

  // ---- Scoring -------------------------------------------------------------

  function scoreRow(room, p, seat) {
    const s = S(room);
    const q = queueMode(room);   // static + waiting share the scoring
    const wait = isWaiting(room);
    const rating = p.rating ?? 0;
    const rides = p.ridesCompleted ?? 0;
    const ridePoints = rides * (q ? STATIC_RIDE_POINTS : s.ridePoints ?? RIDE_POINTS);
    const spread = (p.ridesByDistrict ?? []).filter((n) => n > 0).length;
    const allDistricts = spread >= DISTRICT_COUNT
      ? (q ? STATIC_ALL_DISTRICTS_BONUS : s.allDistrictsBonus ?? ALL_DISTRICTS_BONUS)
      : 0;
    // Being a regular counts everywhere in the queue modes — static has no home
    // district at all, and waiting mode doesn't waive yours.
    let regulars = 0;
    (p.ridesByDistrict ?? []).forEach((n, d) => {
      if ((q || d !== p.home) && n >= REGULAR_RIDES) regulars += 1;
    });
    const regularPoints = regulars * (q ? STATIC_REGULAR_BONUS : s.regularBonus ?? REGULAR_BONUS);
    const errandsDone = p.errandsDone ?? 0;
    const errandsLeft = isStatic(room) ? 0 : (p.errands ?? []).length;
    // Dice mode fines you for the ones left standing. Waiting mode pays for the
    // ones you got, off the rising ladder: 2, 5, 8, 11, 15, 20.
    const errandPenalty = wait ? 0 : errandsLeft * (s.errandPenalty ?? ERRAND_PENALTY);
    const errandPoints = wait ? errandLadder(errandsDone) : 0;
    // A tip is only worth what your rating is worth when the game stops, so a
    // late run of reds costs you every tip you ever banked. FULL stars only,
    // same as the wages at each day's end.
    const tips = q ? p.tipsDelivered ?? 0 : 0;
    const tipPoints = tips * Math.floor(rating);
    const daily = p.points ?? 0;
    return {
      seat,
      name: p.name,
      color: p.color,
      home: p.home,
      homeName: isStatic(room) ? "" : room.uberMania.districts?.[p.home]?.name ?? "",
      daily,
      homeNights: p.homeNights ?? 0,
      rating,
      rides,
      ridePoints,
      spread,
      allDistricts,
      regulars,
      regularPoints,
      tips,
      tipPoints,
      redsRun: p.redsRun ?? 0,
      skipped: p.skipped ?? 0,
      annoyed: p.annoyed ?? 0,
      redsWaited: p.redsWaited ?? 0,
      clockChanges: p.clockChanges ?? 0,
      stonesSpent: p.stonesSpent ?? 0,
      errandsDone,
      errandsLeft,
      errandPenalty,
      errandPoints,
      starsLost: p.starsLost ?? 0,
      total: daily + ridePoints + allDistricts + regularPoints + tipPoints +
        errandPoints - errandPenalty
    };
  }

  function finalizeGame(room) {
    const rows = (room.uberMania.players ?? []).map((p, i) => scoreRow(room, p, i));
    const best = Math.max(...rows.map((r) => r.total));
    // Ties break on rides delivered, then on rating.
    const top = rows.filter((r) => r.total === best);
    const bestRides = Math.max(...top.map((r) => r.rides));
    const byRides = top.filter((r) => r.rides === bestRides);
    const bestRating = Math.max(...byRides.map((r) => r.rating));
    const winners = byRides.filter((r) => r.rating === bestRating).map((r) => r.seat);
    room.uberMania.results = { rows, winners };
    room.uberMania.winner = winners[0] ?? null;
  }

  // ---- State over the wire -------------------------------------------------

  function emitState(roomId, room) {
    const time = room.uberMania.time ?? START_TIME;
    io.to(roomId).emit("state_update", {
      uberMania: {
        map: room.uberMania.map,
        districts: room.uberMania.districts ?? [],
        hour: faceHour(time),
        time,
        night: isNight(time),
        section: sectionOf(time),
        turn: room.uberMania.turn ?? 0,
        turnState: room.uberMania.turnState ?? freshTurnState(),
        winner: room.uberMania.winner ?? null,
        results: room.uberMania.results ?? null,
        elapsed: room.uberMania.elapsed ?? 0,
        speed: roomSpeed(room),
        settings: S(room),
        maxAi: maxAiFor(room),
        aiMove: room.uberMania.aiMove ?? null,
        snapCar: room.uberMania.snapCar ?? null,
        trucks: room.uberMania.trucks,
        mode: modeOf(room),
        preTime: !!S(room).preTime,
        multiMove: !!S(room).multiMove,
        slotRule: S(room).slotRule ?? "two-four",
        priorityStar: priorityStar(room),
        startStars: startingRating(room),
        slots: slotCount(room),
        // The piles show only their backs: how many are left, and the district
        // color plus symbol of whichever tile is on top. `need` is the rating
        // the queue modes ask for before a slot will deal (0 in dice mode).
        // In waiting mode each "pile" is one face-down slot off a shared deck.
        piles: (room.uberMania.piles ?? []).map((pile, i) => ({
          left: pile.length,
          need: queueMode(room) ? pileGates(room)[i] ?? 0 : 0,
          top: pile.length ? { district: pile[0].district, bonus: pile[0].bonus } : null
        })),
        deckLeft: room.uberMania.deck?.length ?? null,
        players: (room.uberMania.players ?? []).map((p) => ({
          ...p,
          showing: showingNumbers(p)
        })),
        lastRoll: room.uberMania.lastRoll ?? null,
        lastToll: room.uberMania.lastToll ?? null,
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

  // ---- Turn order + the AI driver -----------------------------------------
  // Same shape as the other Traffic Time games: an AI turn plays in beats the
  // humans can watch — clock flip, then the drive — each delayed past the
  // client animation it triggers, all scaled by the room's speed dial.

  const CAR_SPEED = 200; // px per second — keep in sync with the client
  const DICE_MS_LOSS = 3700;
  const DICE_MS_SAFE = 2500;
  const TOLL_MS_LOSS = 2600; // static mode's red-light bill — no roll to watch
  const TOLL_MS_SAFE = 1600; // …or the moment a rush passenger waves it through
  const FUN_DIE_MS = 2200;
  const CLOCK_MS = 3600;
  const AI_TURN_GAP_MS = 1000;

  const aiTimers = new Map(); // roomId -> pending setTimeout handle

  function clearAiTimer(roomId) {
    const t = aiTimers.get(roomId);
    if (t) {
      clearTimeout(t);
      aiTimers.delete(roomId);
    }
  }

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

  // Stones score nothing at the end, so hoarding them is pure waste: the AI
  // spends down to a small reserve, and once the last day is running it spends
  // the lot.
  const AI_STONE_RESERVE = 2;
  function aiTimeBudget(room, player) {
    const s = player.timeStones ?? 0;
    if (s <= 0) return 0;
    const lastDay = (room.uberMania.elapsed ?? 0) >= ((S(room).days ?? 3) - 1) * 24;
    return Math.min(11, lastDay ? s : Math.max(4, s - AI_STONE_RESERVE));
  }

  // How far along a segment the nearest point to (px, py) lies, and how far off.
  function projectToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const x = x1 + t * dx;
    const y = y1 + t * dy;
    return { x, y, t, dist: Math.hypot(px - x, py - y) };
  }

  // Every stop sign a path crosses, IN THE ORDER it crosses them, with how far
  // along the path each one sits. Waiting mode lives on this: it isn't the
  // count of reds that matters any more, it's which one you meet first.
  const OCT_REACH = 13;
  function octsAlong(path, intersections, endpoints = []) {
    const cum = [0];
    for (let i = 1; i < path.length; i += 1) {
      cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    }
    const out = [];
    (intersections ?? []).forEach((o, index) => {
      if (endpoints.some(([x, y]) => Math.hypot(o.x - x, o.y - y) < OCT_REACH)) return;
      let best = null;
      for (let i = 0; i < path.length - 1; i += 1) {
        const pr = projectToSegment(o.x, o.y, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
        if (pr.dist >= OCT_REACH) continue;
        const d = cum[i] + Math.hypot(pr.x - path[i][0], pr.y - path[i][1]);
        if (!best || d < best) best = d;
      }
      if (best != null) out.push({ index, d: best, color: o.color, number: o.number, x: o.x, y: o.y });
    });
    return out.sort((a, b) => a.d - b.d);
  }

  // The head of a path, cut at `dist` along it and pointed at (endX, endY) —
  // used to park a car's nose on the red light that stopped it.
  function cutPath(path, dist, endX, endY) {
    const out = [path[0].slice()];
    let run = 0;
    for (let i = 1; i < path.length; i += 1) {
      const seg = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
      if (run + seg >= dist) break;
      run += seg;
      out.push(path[i].slice());
    }
    out.push([endX, endY]);
    return out;
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

  // Flip the clock to a number that nets fewer reds on the route ahead.
  function maybeAiChangeTime(room, player, numbers, greens = []) {
    const ts = room.uberMania.turnState;
    if (!clockAllowed(room) || ts.drew) return false;
    const budget = aiTimeBudget(room, player);
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
      if (gain <= 0) continue;
      const cost = (num % 12 - curPos + 12) % 12;
      if (cost >= 1 && cost <= budget && cost <= player.timeStones) {
        if (!best || gain > best.gain || (gain === best.gain && cost < best.cost)) {
          best = { num, cost, gain };
        }
      }
    }
    if (!best) return false;
    spendClock(room, player, best.cost);
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

  // WAITING MODE's drive. The AI can't buy its way past a red, so it drives at
  // the destination and stops the moment it meets one — parking its nose on the
  // octagon, which is exactly where a later turn will drive straight through.
  // A rush passenger it's dropping off this trip waves one red through.
  function aiWaitDriveTo(room, truck, player, destSpotIdx) {
    const map = room.uberMania.map;
    const spots = map.spots ?? [];
    const dest = spots[destSpotIdx];
    if (!dest) return false;
    const graph = getAiGraph(room);

    // Where the car is standing: a kerb, a light it waited at, or off-board.
    let from;
    let heading;
    let entryStem = null;
    if (truck.spot != null) {
      const here = spots[truck.spot];
      if (!here || destSpotIdx === truck.spot) return false;
      from = [here.x, here.y];
      heading = truck.facing ?? here.angle;
    } else if (truck.light != null) {
      const o = (map.intersections ?? [])[truck.light];
      if (!o) return false;
      from = [o.x, o.y];
      heading = truck.facing ?? 0;
    } else {
      // Coming on from the edge: greens first, so the car doesn't burn its whole
      // first turn stopping on the doorstep.
      const lights = [...edgeLights(map)].sort((a, b) => {
        const ga = a.color === "green" ? 0 : 1;
        const gb = b.color === "green" ? 0 : 1;
        if (ga !== gb) return ga - gb;
        return Math.hypot(a.x - dest.x, a.y - dest.y) - Math.hypot(b.x - dest.x, b.y - dest.y);
      });
      const light = lights[0];
      if (!light) return false;
      const [ix, iy] = inwardDir(map, light);
      from = [light.x, light.y];
      heading = (Math.atan2(iy, ix) * 180) / Math.PI;
      entryStem = [light.x - ix * 46, light.y - iy * 46];
      // A red on the edge is a light you have to wait at like any other.
      if (light.color === "red") {
        truck.facing = heading;
        applyWaitMove(room, truck, { light: map.intersections.indexOf(light) });
        room.uberMania.aiMove = {
          truckId: truck.id, path: [entryStem, [light.x, light.y]], endAngle: heading
        };
        room.uberMania.driveMs = 900;
        return true;
      }
    }

    let route = findRouteDirected(
      graph, map.intersections, from[0], from[1], heading, dest.x, dest.y, false
    );
    if (route && route.reds > 0) {
      const rd = redsAlong(route.path, map.intersections, [from, [dest.x, dest.y]]);
      if (rd.count > 0 && maybeAiChangeTime(room, player, rd.nums, rd.greens)) {
        room.uberMania.clockMs = CLOCK_MS;
        route = findRouteDirected(
          graph, map.intersections, from[0], from[1], heading, dest.x, dest.y, false
        ) || route;
      }
    }
    if (!route) return false;

    // A rush fare being dropped off at the far end pays for one red.
    const destBid = dest.building;
    let passes = (player.passengers ?? [])
      .filter((t) => !t.done && t.bonus === "rush" && t.loc === destBid).length;
    const order = octsAlong(route.path, map.intersections, [from, [dest.x, dest.y]]);
    let block = null;
    for (const o of order) {
      if (o.color !== "red") continue;
      if (passes > 0) {
        passes -= 1;
        continue;
      }
      block = o;
      break;
    }

    if (!block) {
      truck.facing = route.endAngle;
      applyWaitMove(room, truck, { spot: destSpotIdx });
      const path = entryStem ? [entryStem, ...route.path] : route.path;
      room.uberMania.aiMove = { truckId: truck.id, path, endAngle: route.endAngle };
      room.uberMania.driveMs = Math.max(450, (pathLen(path) / CAR_SPEED) * 1000) + 300;
      return true;
    }
    const cut = cutPath(route.path, block.d, block.x, block.y);
    const path = entryStem ? [entryStem, ...cut] : cut;
    truck.facing = lastAngle(path);
    applyWaitMove(room, truck, { light: block.index });
    room.uberMania.aiMove = { truckId: truck.id, path, endAngle: truck.facing };
    room.uberMania.driveMs = Math.max(450, (pathLen(path) / CAR_SPEED) * 1000) + 300;
    return true;
  }

  function lastAngle(path, fallback = 0) {
    for (let i = path.length - 1; i > 0; i -= 1) {
      const dx = path[i][0] - path[i - 1][0];
      const dy = path[i][1] - path[i - 1][1];
      if (Math.hypot(dx, dy) > 0.01) return (Math.atan2(dy, dx) * 180) / Math.PI;
    }
    return fallback;
  }

  // Drive the AI's car to a spot, greening a red on the way when affordable.
  function aiDriveCarTo(room, truck, player, destSpotIdx) {
    if (isWaiting(room)) return aiWaitDriveTo(room, truck, player, destSpotIdx);
    if (truck.spot == null) return aiEnterCar(room, truck, player, destSpotIdx);
    const map = room.uberMania.map;
    const spots = map.spots ?? [];
    const here = spots[truck.spot];
    const dest = spots[destSpotIdx];
    if (!here || !dest || destSpotIdx === truck.spot) return false;
    const graph = getAiGraph(room);
    const heading = truck.facing ?? here.angle;

    let route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y, false);
    if (route && route.reds > 0) {
      const rd = redsAlong(route.path, map.intersections, [[here.x, here.y], [dest.x, dest.y]]);
      if (rd.count > 0 && maybeAiChangeTime(room, player, rd.nums, rd.greens)) {
        room.uberMania.clockMs = CLOCK_MS;
        route = findRouteDirected(graph, map.intersections, here.x, here.y, heading, dest.x, dest.y, false) || route;
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

  // ---- AI valuation --------------------------------------------------------

  // What one whole star is worth in end-game points: a point at every day's
  // end that's still to come, plus a little for the half-star buffer it gives
  // against the dice.
  function starValue(room, player = null) {
    const days = S(room).days ?? 3;
    const left = Math.max(0, days - Math.floor((room.uberMania.elapsed ?? 0) / 24));
    if (isWaiting(room)) {
      // No wages at day's end here. A star buys exactly two things: a point on
      // every tip already banked, and the key to the deeper slots — and it's
      // the slots that really bite. A driver who lets their rating slide under
      // the 2★ gate is down to one slot to draw from and stops getting fares
      // at all, so a star is worth most to whoever has least.
      const r = player?.rating ?? 0;
      const gates = pileGates(room);
      const shut = gates.filter((g) => r < g).length; // slots this rating can't open
      const gate = shut >= 2 ? 3 : shut === 1 ? 1.8 : 0.9;
      return gate + (player?.tipsDelivered ?? 0) * 0.9;
    }
    if (queueMode(room)) {
      // A star is worth far more here: a point at every day's end still to
      // come, a point on every tip already banked, and the key to the deeper
      // piles. Which is what makes a red light genuinely frightening.
      return Math.max(1, left) + (player?.tipsDelivered ?? 0) * 0.9 + 0.4;
    }
    return Math.max(0.6, left * 0.9);
  }

  // The chance one die misses the board as it stands: the numbers NOT showing,
  // over six.
  function failChance(player) {
    return (6 - showingNumbers(player).length) / 6;
  }

  // What running `reds` red lights is expected to cost, in points. Static mode
  // doesn't gamble: it's a whole star each, less whatever the rush passengers
  // being dropped off this trip wave through.
  function aiRedRisk(room, player, reds, rushAtDest = 0) {
    const unpaid = Math.max(0, reds - rushAtDest);
    if (isWaiting(room)) {
      // Nothing is charged here — but the first red STOPS you, so a route with
      // one in it doesn't arrive this turn at all. The cost is the wasted trip.
      return unpaid > 0 ? 1.6 + unpaid * 0.15 : 0;
    }
    if (isStatic(room)) {
      return unpaid * RED_STAR_COST * starValue(room, player);
    }
    return reds * failChance(player) * FAIL_STAR_STEP * starValue(room);
  }

  // Every stop worth driving to right now, with what it's worth in points.
  function aiCandidates(room, seat, truck, player) {
    const map = room.uberMania.map;
    const spots = map.spots ?? [];
    const here = truck.spot != null
      ? spots[truck.spot]
      : truck.light != null ? (map.intersections ?? [])[truck.light] : null;
    const now = sectionOf(room.uberMania.time ?? START_TIME);
    const s = S(room);
    const stat = queueMode(room);
    const sv = starValue(room, player);
    // A star you can't actually gain is worth nothing. Ratings sit at the cap
    // for long stretches — especially in waiting mode, where almost nothing
    // drains them — and pricing the priority bonus as if it always lands made
    // every fare look better than every errand, which is why the AI never ran
    // one. Value it by the headroom it would actually fill.
    const cap = s.ratingMax ?? RATING_MAX;
    const gain = Math.max(0, Math.min(priorityStar(room), cap - (player.rating ?? 0)));
    const priorityValue = gain * sv;
    const byBid = new Map();
    const rushByBid = new Map(); // static: free reds waiting at this address

    const add = (bid, value) => {
      if (value <= 0) return;
      byBid.set(bid, (byBid.get(bid) ?? 0) + value);
    };

    const waiting = (player.passengers ?? []).filter((t) => !t.done);
    for (const t of player.passengers ?? []) {
      if (t.done) continue;
      let v = stat ? STATIC_RIDE_POINTS : s.ridePoints ?? RIDE_POINTS;
      if (stat) {
        // The queue is the whole decision: the front fare pays a star, anyone
        // further back costs half a star for each head you reach over.
        const skipped = waiting.filter((o) => o.slot < t.slot).length;
        v += skipped === 0 ? priorityValue : -skipped * SKIP_STAR_STEP * sv;
        if (t.bonus === "tip") v += Math.max(1, Math.floor(player.rating ?? 0));
        if (t.bonus === "rush") rushByBid.set(t.loc, (rushByBid.get(t.loc) ?? 0) + 1);
      } else if (t.bonus === "star") {
        v += sv;
      }
      // Finishing a district (the all-six bonus) or reaching regular status is
      // worth chasing on its own.
      const ridesHere = player.ridesByDistrict?.[t.district] ?? 0;
      if (ridesHere === 0) {
        const spread = (player.ridesByDistrict ?? []).filter((n) => n > 0).length;
        const allBonus = stat ? STATIC_ALL_DISTRICTS_BONUS : s.allDistrictsBonus ?? ALL_DISTRICTS_BONUS;
        v += spread >= DISTRICT_COUNT - 1 ? allBonus : 0.35;
      }
      if ((stat || t.district !== player.home) && ridesHere === REGULAR_RIDES - 1) {
        v += stat ? STATIC_REGULAR_BONUS : s.regularBonus ?? REGULAR_BONUS;
      }
      // A tile off the board is a number back on it — worth real points when
      // the car is full. (Dice mode only; static's board carries no numbers.)
      if (!stat) v += failChance(player) * 0.6;
      add(t.loc, v);
    }

    if (hasErrands(room)) {
      const done = player.errandsDone ?? 0;
      const left = (player.errands ?? []).length;
      // Waiting mode pays the set off a rising ladder. Valuing the next errand
      // at its own step alone makes the FIRST worth two points, so a greedy
      // driver never starts the set and never collects the 20 — it always has a
      // fare worth more. Value it instead at what each remaining one would
      // average if the set were finished, which is what makes errands a plan
      // rather than a rounding error. Dragging a full car through one still
      // annoys everybody in it.
      const target = done + left;
      const perErrand = left > 0
        ? (errandLadder(target) - errandLadder(done)) / left
        : 0;
      // Two thumbs on the scale, both of them real facts a human reads without
      // thinking. First, an errand is only collectable while its district's
      // section is running, and this list already only holds the open ones — a
      // fare can be delivered at any hour, so an open errand is the perishable
      // one. Second, the payoff is superlinear, so the set is worth committing
      // to. Without this the AI is a hair short of a fare EVERY time and so
      // runs literally zero errands all game, which is worse play than either
      // extreme. The annoyance counts at half face value for the same reason:
      // the alternative is a whole separate trip back with an empty car.
      const URGENCY = 1.35;
      const errandValue = isWaiting(room)
        ? perErrand * URGENCY - waiting.length * ERRAND_ANNOY_STEP * sv * 0.5
        : s.errandPenalty ?? ERRAND_PENALTY;
      for (const bid of player.errands ?? []) {
        const b = buildingByBid(map, bid);
        if (!b) continue;
        const district = room.uberMania.districts?.[b.district];
        if (!district || district.section !== now) continue; // shut at this hour
        add(bid, errandValue);
      }
    }

    const out = [];
    for (const [bid, value] of byBid) {
      const b = buildingByBid(map, bid);
      if (!b) continue;
      const rush = rushByBid.get(bid) ?? 0;
      for (let i = 0; i < spots.length; i += 1) {
        if (spots[i].building !== b.bid) continue;
        if ((room.uberMania.trucks ?? []).some((t) => t.id !== truck.id && t.spot === i)) continue;
        const d = here ? Math.hypot(spots[i].x - here.x, spots[i].y - here.y) : 420;
        out.push({ bid, spot: i, value, d, rush });
      }
    }
    return out;
  }

  // Is taking a tile the better use of this turn? A near-empty car has nothing
  // to deliver, and the board's safe numbers are already as good as they get.
  function aiWantsTile(room, player, best) {
    const piles = room.uberMania.piles ?? [];
    if (!piles.some((p, i) => p.length && !pileLocked(room, player, i))) return false;
    if (lowestFreeSlot(room, player) < 0) return false;
    const live = (player.passengers ?? []).filter((t) => !t.done).length;
    if (live === 0) return true;
    // Waiting mode's clock runs on time stones and on nothing else — an hour
    // only passes because somebody paid for it. A table that runs dry doesn't
    // just play badly, it FREEZES: cars still drive and still stop at reds, but
    // the day never ends and the game can't finish. A chill tile showing on an
    // open slot is worth the turn whenever the bank is low, whatever else this
    // driver had planned; and a driver down to its last couple of stones draws
    // anyway, to churn the river until a chill one comes up.
    if (isWaiting(room)) {
      const stones = player.timeStones ?? 0;
      const open = piles.some((p, i) => p.length && !pileLocked(room, player, i));
      const chill = piles.some((p, i) =>
        p.length && !pileLocked(room, player, i) && p[0].bonus === "chill");
      if (open && (stones <= 2 || (chill && stones < 8))) return true;
    }
    if (!best) return true;
    // A tile costs the turn, so it has to beat what driving would have paid.
    // The queue modes load up more reluctantly: every fare you add is one more
    // head to reach over later, and the queue only ever costs you stars. In
    // waiting mode a driver with errands still to run keeps the car lighter
    // still — every passenger aboard is half a star off the next errand.
    const chores = isWaiting(room) && (player.errands ?? []).length > 0;
    const wantMore = chores
      ? (live < 1 ? 2.6 : live < 2 ? 1.0 : 0.25)
      : queueMode(room)
      ? (live < 2 ? 2.6 : live < 3 ? 1.3 : 0.4)
      : (live < 2 ? 1.7 : live < 3 ? 1.1 : 0.55);
    return best.score < wantMore;
  }

  // Which pile to take from: the one whose top tile points at a district this
  // player still has business in. Dice mode prefers star tiles; static mode
  // weighs the three kinds against what the driver is short of, and can't touch
  // a pile its rating won't open.
  function aiPickPile(room, player) {
    const piles = room.uberMania.piles ?? [];
    const stat = queueMode(room);
    let best = null;
    piles.forEach((pile, i) => {
      if (!pile.length || pileLocked(room, player, i)) return;
      const top = pile[0];
      let v;
      if (stat) {
        v = 0.4;
        if (top.bonus === "chill") v += (player.timeStones ?? 0) < 8 ? 1.5 : 0.3;
        if (top.bonus === "tip") v += 0.4 * Math.max(1, Math.floor(player.rating ?? 0));
        if (top.bonus === "rush") v += 0.9;
      } else {
        v = top.bonus === "star" ? starValue(room) : 0.35;
        if ((player.timeStones ?? 0) < 4 && top.bonus === "stones") v += 0.6;
      }
      const rides = player.ridesByDistrict?.[top.district] ?? 0;
      if (rides === 0) v += 0.5;
      if ((stat || top.district !== player.home) && rides === REGULAR_RIDES - 1) v += 0.8;
      if (!best || v > best.v) best = { i, v };
    });
    return best ? best.i : -1;
  }

  // Buy hours to open the section an errand is waiting in, when there's
  // nothing better on the road. This is also the only thing that pushes the
  // clock along at an all-AI table.
  function aiBuyTime(room, seat, player) {
    const ts = room.uberMania.turnState;
    if (!clockAllowed(room) || ts.drew) return false;
    const map = room.uberMania.map;
    const t = room.uberMania.time ?? START_TIME;
    // Which sections does this player still have errands waiting in?
    const wanted = new Set();
    for (const bid of player.errands ?? []) {
      const b = buildingByBid(map, bid);
      const d = b ? room.uberMania.districts?.[b.district] : null;
      if (d) wanted.add(d.section);
    }
    if (!wanted.size) return false;
    if (wanted.has(sectionOf(t)) && (player.errands ?? []).length > 1) {
      // The section is already open — no reason to burn stones on it.
      return false;
    }
    let cost = 0;
    for (let h = 1; h <= 12; h += 1) {
      if (wanted.has(sectionOf((t + h) % 24))) { cost = h; break; }
    }
    if (!cost || (player.timeStones ?? 0) < cost) return false;
    ts.changedTime = true;
    spendClock(room, player, cost);
    const arrival = faceHour(room.uberMania.time);
    for (const oct of map.intersections) {
      if (oct.number === arrival) oct.color = oct.color === "green" ? "red" : "green";
    }
    resolveParked(room, seat);
    room.uberMania.clockMs = CLOCK_MS;
    return true;
  }

  // Static mode has no errands waiting on the clock, so nothing would ever push
  // the hand round on a table of AI — and the game ends on elapsed hours. A
  // driver with stones to spare spends a few, picking the hour whose stop signs
  // turn the most reds green near where it's standing. The flip is worth having
  // on its own, and the day has to end sometime.
  function aiPassTime(room, seat, player) {
    const ts = room.uberMania.turnState;
    if (!clockAllowed(room) || ts.drew) return false;
    // A small reserve, not a hoard: stones ARE the clock in waiting mode, and
    // 72 hours have to be paid for out of everyone's pockets before the game
    // can end. Keeping four back on a four-stone opening bank stalls the day.
    const spendable = Math.min(6, (player.timeStones ?? 0) - 2);
    if (spendable < 1) return false;
    const map = room.uberMania.map;
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === seat);
    const here = truck && truck.spot != null ? (map.spots ?? [])[truck.spot] : null;
    const curPos = (room.uberMania.time ?? START_TIME) % 12;
    let best = null;
    for (let cost = 1; cost <= spendable; cost += 1) {
      const num = ((curPos + cost - 1) % 12) + 1;
      let gain = 0;
      for (const o of map.intersections ?? []) {
        if (o.number !== num) continue;
        const near = here ? Math.max(0.1, 1 - Math.hypot(o.x - here.x, o.y - here.y) / 320) : 0.4;
        gain += (o.color === "red" ? 1 : -1) * near;
      }
      const score = gain - cost * 0.12;
      if (!best || score > best.score) best = { num, cost, score };
    }
    if (!best) return false;
    ts.changedTime = true;
    spendClock(room, player, best.cost);
    for (const oct of map.intersections ?? []) {
      if (oct.number === best.num) oct.color = oct.color === "green" ? "red" : "green";
    }
    room.uberMania.clockMs = CLOCK_MS;
    return true;
  }

  // The AI's whole turn: rank the stops, decide between driving and taking a
  // passenger, and go.
  function aiTakeTurn(room, idx) {
    const player = room.uberMania.players?.[idx];
    const truck = (room.uberMania.trucks ?? []).find((t) => t.player === idx);
    if (!player || !truck) return false;
    const map = room.uberMania.map;
    const spots = map.spots ?? [];
    const graph = getAiGraph(room);

    const pickBest = () => {
      const cands = aiCandidates(room, idx, truck, player)
        .sort((a, b) => (b.value - b.d * 0.0006) - (a.value - a.d * 0.0006));
      let top = null;
      for (const c of cands.slice(0, 7)) {
        let score;
        // Wherever the car is standing — a kerb, or a light it waited at.
        const here = truck.spot != null
          ? spots[truck.spot]
          : truck.light != null ? (map.intersections ?? [])[truck.light] : null;
        if (c.spot === truck.spot) {
          score = c.value; // already parked there — nothing to drive
        } else if (!here) {
          score = c.value - aiRedRisk(room, player, 1.5, c.rush ?? 0) - c.d * 0.0006;
        } else {
          const dest = spots[c.spot];
          const route = findRouteDirected(
            graph, map.intersections, here.x, here.y,
            truck.facing ?? here.angle ?? 0, dest.x, dest.y, false
          );
          const reds = route ? route.reds : 2;
          score = c.value - aiRedRisk(room, player, reds, c.rush ?? 0) - c.d * 0.0006;
        }
        if (!top || score > top.score) top = { ...c, score };
      }
      return top;
    };

    let best = pickBest();
    // A car with nothing worth driving to takes on a fare instead.
    if (aiWantsTile(room, player, best)) {
      const pile = aiPickPile(room, player);
      if (pile >= 0 && drawTileCore(room, idx, pile)) return false;
    }
    // Still nothing? Buy hours — in dice mode the ones that open an errand's
    // section, in static mode just enough to keep the hand moving — then
    // re-rank, since the lights it just flipped change what's worth driving to.
    const idle = !best || best.score < 0.5;
    const flush = (player.timeStones ?? 0) >= 14;
    // Waiting mode falls back to the plain nudge once its errands are done —
    // otherwise a table that finished them would leave the clock standing still
    // and the game would never reach its last hour.
    const bought = isStatic(room)
      ? (idle || flush) && aiPassTime(room, idx, player)
      : (idle && aiBuyTime(room, idx, player)) ||
        (isWaiting(room) && (idle || flush) && aiPassTime(room, idx, player));
    if (bought) best = pickBest();

    // Waiting mode's clock is bought entirely out of players' pockets, and once
    // a driver has errands to chase it always has somewhere to be — so it is
    // never "idle" and the hand stops moving altogether. A driver holding more
    // stones than it needs spends the surplus, whether or not it drove.
    const nudge = () => {
      if (!isWaiting(room) || (player.timeStones ?? 0) < 5) return;
      aiPassTime(room, idx, player);
    };

    if (!best || best.spot === truck.spot) {
      nudge();
      return false;
    }
    const moved = aiDriveCarTo(room, truck, player, best.spot);
    nudge();
    return moved;
  }

  function runAiTurn(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.gameId !== "uber-mania") return;
    const idx = room.uberMania.turn;
    if (!room.uberMania.players?.[idx]?.isAI) return;
    if (room.uberMania.winner != null) return;
    room.uberMania.clockMs = 0;
    const moved = aiTakeTurn(room, idx);
    emitState(roomId, room);
    clearAiTimer(roomId);
    const driveMs = moved ? Math.ceil(room.uberMania.driveMs ?? 1800) : 0;
    const delay = moved
      ? ((room.uberMania.clockMs ?? 0) + driveMs + 600) / roomSpeed(room)
      : ((room.uberMania.clockMs ?? 0) + 600) / roomSpeed(room);
    aiTimers.set(roomId, setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r || r.gameId !== "uber-mania") return;
      endTurnCore(roomId, idx);
    }, delay));
  }

  // ---- The game module -----------------------------------------------------

  return {
    id: "uber-mania",

    createRoomState() {
      const settings = cloneSettings(BASE_SETTINGS);
      const state = {
        uberMania: {
          map: makeMap(),
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
        room.uberMania.map = makeMap();
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

      // How many AI opponents share the table (0 up to the free seats).
      socket.on("uber_mania_set_opponents", ({ roomId, count } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        clearAiTimer(roomId);
        room.uberMania.aiCount = Math.max(0, Math.min(maxAiFor(room), Number(count) | 0));
        setupBoard(room);
        room.uberMania.map.seed = `${room.uberMania.map.seed}-o${room.uberMania.aiCount}-${Date.now()}`;
        emitState(roomId, room);
      });

      // Drive. The client routes and reports what it crossed — in dice/static
      // mode that's a count of reds (each banks a die); in waiting mode it's the
      // kerbs the route called at and whether it finished at an address or
      // stopped with its nose on a red light. Occupied places are off limits.
      socket.on("uber_mania_move_truck", (msg = {}) => {
        const { roomId, truckId = 0, spot, reds } = msg;
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const seat = seatOf(room, socket);
        if (room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const ts = room.uberMania.turnState;
        // `carryOn` is multi-move's second wind: the last drive ended on a
        // drop-off or an errand, so this driver may pull away again.
        if ((ts.acted && !ts.carryOn) || ts.drew) return;
        const truck = humanTruck(room, seat, truckId);
        if (!truck) return;
        const map = room.uberMania.map;
        const spotCount = map.spots?.length ?? 0;
        const lightCount = map.intersections?.length ?? 0;
        const wait = isWaiting(room);

        // Where the drive ends, and — in waiting mode — everywhere it called at.
        let endSpot = null;
        let endLight = null;
        let visited = [];
        if (wait) {
          const light = msg.light;
          if (Number.isInteger(light)) {
            if (light < 0 || light >= lightCount) return;
            // A light holds as many cars as meet it — only kerbs are exclusive.
            endLight = light;
          } else if (Number.isInteger(spot)) {
            if (spot < 0 || spot >= spotCount) return;
            if (spotTaken(room, spot, truck.id)) return;
            endSpot = spot;
          } else {
            return;
          }
          if (endSpot != null && truck.spot === endSpot) return;
          if (endLight != null && truck.light === endLight) return;
          visited = (Array.isArray(msg.visited) ? msg.visited : [])
            .filter((i) => Number.isInteger(i) && i >= 0 && i < spotCount && i !== endSpot);

          // A rush passenger buys you one red — but only on the way to THEM.
          // Cross a red and the drive has to finish at a rushing fare's address.
          const rush = (room.uberMania.players?.[seat]?.passengers ?? [])
            .filter((t) => !t.done && t.bonus === "rush");
          const crossed = Number.isInteger(msg.reds) ? Math.max(0, msg.reds) : 0;
          if (crossed > rush.length) return;
          if (crossed > 0) {
            const endBid = endSpot != null ? map.spots?.[endSpot]?.building : null;
            if (endBid == null || !rush.some((t) => t.loc === endBid)) return;
          }
        } else {
          if (!Number.isInteger(spot) || spot < 0 || spot >= spotCount) return;
          if (truck.spot === spot) return;
          if (spotTaken(room, spot, truck.id)) return;
          endSpot = spot;
        }

        const player = room.uberMania.players?.[seat];
        // Arriving delivers fares and picks errands up — and in waiting mode an
        // errand run with a full car costs stars on the spot — so the undo has
        // to carry the passenger board, the errands AND the rating back with it.
        ts.undo = {
          kind: "move",
          truckId: truck.id,
          prevSpot: truck.spot,
          prevLight: truck.light ?? null,
          prevFacing: truck.facing ?? 0,
          prevTurnTruck: ts.truck ?? null,
          // Multi-move lets a turn hold more than one drive, so undoing the
          // second must put the turn back to "already acted", not to untouched.
          prevActed: !!ts.acted,
          prevCarryOn: !!ts.carryOn,
          prevDicePool: ts.dicePool ?? 0,
          prevPassengers: (player?.passengers ?? []).map((t) => ({ ...t })),
          prevErrands: (player?.errands ?? []).slice(),
          prevErrandsDone: player?.errandsDone ?? 0,
          prevRating: player?.rating ?? 0,
          prevStarsLost: player?.starsLost ?? 0,
          prevAnnoyed: player?.annoyed ?? 0
        };
        if (wait) {
          const facing = Number.isFinite(msg.facing) ? msg.facing : null;
          applyWaitMove(room, truck, { spot: endSpot, light: endLight, visited, facing });
        } else {
          applyMove(room, truck, endSpot, reds);
        }
        emitState(roomId, room);
      });

      // Which ruleset the table is playing. Both the deck and the passenger
      // board change shape, so this re-deals the whole thing.
      socket.on("uber_mania_set_mode", ({ roomId, mode } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || !MODES.includes(mode)) return;
        if ((S(room).mode ?? "dice") === mode) return;
        clearAiTimer(roomId);
        room.uberMania.settings = { ...S(room), mode };
        setupBoard(room);
        // Nudge the seed so the client tears the board down and rebuilds it.
        room.uberMania.map.seed = `${room.uberMania.map.seed}-${mode}-${Date.now()}`;
        emitState(roomId, room);
      });

      // The PRE-TIME table rule: must the clock be set before you act?
      socket.on("uber_mania_set_pretime", ({ roomId, on } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        room.uberMania.settings = { ...S(room), preTime: !!on };
        emitState(roomId, room);
      });

      // MULTI-MOVE: does a drop-off or an errand end the drive, or drive on?
      socket.on("uber_mania_set_multimove", ({ roomId, on } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        room.uberMania.settings = { ...S(room), multiMove: !!on };
        emitState(roomId, room);
      });

      // Which slot layout the table deals. It changes how many slots there are
      // and what they cost, so the whole table has to be dealt again.
      socket.on("uber_mania_set_slots", ({ roomId, rule } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room || !SLOT_RULES.includes(rule)) return;
        if ((S(room).slotRule ?? "two-four") === rule) return;
        clearAiTimer(roomId);
        const next = { ...S(room), slotRule: rule };
        // Two slots and a 3★ gate means a table opening under it gets no choice
        // at all on its first pickup, so dealing this layout lifts everyone to
        // the gate. It's a nudge to the setting, not an override — the table can
        // set the opening rating to whatever it likes afterwards.
        if (rule === "three" && (next.startingRating ?? RATING_START) < THREE_START_RATING) {
          next.startingRating = THREE_START_RATING;
        }
        room.uberMania.settings = next;
        setupBoard(room);
        // Same as switching ruleset: the deal changes the districts and puts
        // the cars back in the garage, so the client rebuilds from scratch.
        room.uberMania.map.seed = `${room.uberMania.map.seed}-${rule}-${Date.now()}`;
        emitState(roomId, room);
      });

      // What the front of the queue pays. A payout rule, not a deal — it takes
      // effect on the next delivery and the table plays on.
      socket.on("uber_mania_set_priority_star", ({ roomId, value } = {}) => {
        const room = playerRoom(socket, roomId);
        const v = Number(value);
        if (!room || !(v === 0.5 || v === 1)) return;
        room.uberMania.settings = { ...S(room), priorityStar: v };
        emitState(roomId, room);
      });

      // What everyone opens on. This one IS the deal, so the table is dealt again.
      socket.on("uber_mania_set_start_stars", ({ roomId, stars } = {}) => {
        const room = playerRoom(socket, roomId);
        if (!room) return;
        const v = clampRating(room, stars);
        if (!Number.isFinite(v) || v === (S(room).startingRating ?? RATING_START)) return;
        clearAiTimer(roomId);
        room.uberMania.settings = { ...S(room), startingRating: v };
        setupBoard(room);
        room.uberMania.map.seed = `${room.uberMania.map.seed}-r${v}-${Date.now()}`;
        emitState(roomId, room);
      });

      // Take the top tile off a pile — the whole turn's action.
      socket.on("uber_mania_draw_tile", ({ roomId, pile = 0 } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const idx = Number(pile) | 0;
        if (idx < 0 || idx >= (room.uberMania.piles?.length ?? 0)) return;
        if (drawTileCore(room, seat, idx)) emitState(roomId, room);
      });

      // Move the clock hand: one stone per hour swept (clockwise only), the
      // stop signs carrying that number flip, once per turn.
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
        if (!clockAllowed(room)) return;
        const cost = (targetPos - curPos + 12) % 12;
        if (!player || player.timeStones < cost) return;
        ts.changedTime = true;

        // Sweeping past 1am ends a day, but the wages only land when the turn
        // does — so the undo just has to un-pend it.
        const prevPending = room.uberMania.pendingDay ?? 0;
        const prevErrands = (player.errands ?? []).slice();
        const prevErrandsDone = player.errandsDone ?? 0;
        const prevRating = player.rating ?? 0;
        const prevStarsLost = player.starsLost ?? 0;
        const prevAnnoyed = player.annoyed ?? 0;
        spendClock(room, player, cost);
        for (const oct of room.uberMania.map.intersections) {
          if (oct.number === hour) oct.color = oct.color === "green" ? "red" : "green";
        }
        // The new hour may have opened the errand the car is already sitting on.
        resolveParked(room, seat);
        ts.undo = {
          kind: "time", prevTime: t, hour, cost, prevPending,
          prevErrands, prevErrandsDone, prevRating, prevStarsLost, prevAnnoyed
        };
        emitState(roomId, room);
      });

      // One-step undo: take back the turn's latest drive (the car returns,
      // banked dice un-bank, deliveries and errands come back) or clock change.
      socket.on("uber_mania_undo", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        const ts = room.uberMania.turnState;
        const undo = ts.undo;
        const player = room.uberMania.players?.[seat];
        if (!undo || !player) return;
        if (undo.kind === "move") {
          const truck = (room.uberMania.trucks ?? [])
            .find((t) => t.id === undo.truckId && t.player === seat);
          if (!truck) return;
          // An errand picked up on the way has to go back on its corner.
          restoreErrands(room, seat, undo.prevErrands);
          truck.spot = undo.prevSpot;
          truck.light = undo.prevLight ?? null;
          truck.facing = undo.prevFacing;
          // An undone drive never happened, so the car must not DRIVE back —
          // tell the client to snap it, position and facing both.
          room.uberMania.snapCar = {
            truckId: truck.id, spot: truck.spot, light: truck.light, facing: truck.facing
          };
          ts.truck = undo.prevTurnTruck;
          ts.acted = !!undo.prevActed;
          ts.carryOn = !!undo.prevCarryOn;
          ts.dicePool = undo.prevDicePool;
          player.passengers = undo.prevPassengers ?? player.passengers;
          player.errandsDone = undo.prevErrandsDone ?? player.errandsDone;
          if (undo.prevRating != null) player.rating = undo.prevRating;
          if (undo.prevStarsLost != null) player.starsLost = undo.prevStarsLost;
          if (undo.prevAnnoyed != null) player.annoyed = undo.prevAnnoyed;
          room.uberMania.lastRoll = null;
        } else if (undo.kind === "time") {
          room.uberMania.time = undo.prevTime;
          room.uberMania.elapsed = Math.max(0, (room.uberMania.elapsed ?? 0) - undo.cost);
          player.timeStones += undo.cost;
          // The stats have to unwind with it, or an undone change still counts.
          player.stonesSpent = Math.max(0, (player.stonesSpent ?? 0) - undo.cost);
          player.clockChanges = Math.max(0, (player.clockChanges ?? 0) - 1);
          if (undo.prevPending != null) room.uberMania.pendingDay = undo.prevPending;
          for (const oct of room.uberMania.map.intersections) {
            if (oct.number === undo.hour) oct.color = oct.color === "green" ? "red" : "green";
          }
          restoreErrands(room, seat, undo.prevErrands);
          player.errandsDone = undo.prevErrandsDone ?? player.errandsDone;
          if (undo.prevRating != null) player.rating = undo.prevRating;
          if (undo.prevStarsLost != null) player.starsLost = undo.prevStarsLost;
          if (undo.prevAnnoyed != null) player.annoyed = undo.prevAnnoyed;
          ts.changedTime = false;
        }
        ts.undo = null;
        emitState(roomId, room);
        room.uberMania.snapCar = null; // one-shot: only this update carries it
      });

      // End the turn: roll the banked dice (or the fun die when a driving turn
      // banked none), drop the delivered fares, then pass the turn on — or
      // score the game once the last day's hours have run out.
      socket.on("uber_mania_end_turn", ({ roomId } = {}) => {
        const room = playerRoom(socket, roomId);
        const seat = room ? seatOf(room, socket) : -1;
        if (!room || room.uberMania.turn !== seat || room.uberMania.winner != null) return;
        endTurnCore(roomId, seat);
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
