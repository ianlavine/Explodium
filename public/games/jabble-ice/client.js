// Jabble Ice: Jabble on an empty rink — no obstacles, a ball twice the size,
// and you slide. What's different lives in the server engine's VARIANTS; this
// side is Jabble's own client, which draws the floor as ice when the server
// says so. It borrows Jabble's stylesheet (see `styles` in the shell's GAMES).
import { createJabbleClient } from "../jabble/client.js";

export const jabbleIce = createJabbleClient({ id: "jabble-ice", name: "Jabble Ice", stateKey: "jabbleIce" });
