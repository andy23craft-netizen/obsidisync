import { instance } from "@viz-js/viz";
import { readFile, writeFile } from "node:fs/promises";

const viz = await instance();
for (const name of ["context", "container"]) {
  const source = new URL(`diagrams/${name}.dot`, import.meta.url);
  const svg = viz.renderString(await readFile(source, "utf8"), { format: "svg", engine: "dot" });
  await writeFile(new URL(`diagrams/${name}.svg`, import.meta.url), svg);
  console.log(`Rendered ${name}.svg`);
}
