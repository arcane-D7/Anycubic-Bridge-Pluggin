import fs from "node:fs";
const t = fs.readFileSync("poc-output/uia-check.json", "utf8");
const re =
  /"name": "(Fatiar[^"]*|Impressao[^"]*|Export[^"]*)","[\s\S]{0,400}?"enabled": (true|false)/g;
let m;
const out = [];
while ((m = re.exec(t)) !== null) {
  out.push(`${m[1]} -> enabled=${m[2]}`);
}
console.log(out.length ? out.join("\n") : "(no matches)");
