import { read3mf } from "./read-3mf.mjs";

const path = process.argv[2];
const f = read3mf(path).find((f) => f.name === "3D/3dmodel.model");
const s = f.data.toString("utf8");
const bi = s.indexOf("<build");
console.log("=== build item ===");
console.log(s.slice(bi, bi + 340));
console.log("=== objects in resources ===");
const ids = [...s.matchAll(/<object id="(\d+)"/g)].map((m) => m[1]);
console.log("object ids:", ids.join(", "));
