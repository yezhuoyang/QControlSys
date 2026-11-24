// Writes the exercise and star counts of every written lesson into curriculum.json.
//   node studio/course/sync-counts.mjs
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir, "curriculum.json");
const curriculum = JSON.parse(readFileSync(file, "utf8"));
for (const part of curriculum.parts)
  for (const lesson of part.lessons) {
    const page = path.join(dir, lesson.id + ".html");
    if (!existsSync(page)) {
      delete lesson.exercises;
      delete lesson.stars;
      continue;
    }
    const boxes = [...readFileSync(page, "utf8").matchAll(/<div class="ex"([^>]*)>/g)];
    lesson.exercises = boxes.length;
    lesson.stars = boxes.reduce((n, m) => n + Number(/data-stars="(\d)"/.exec(m[1])?.[1] ?? 1), 0);
    console.log(lesson.id.padEnd(4) + String(lesson.exercises).padStart(3) + " exercises " + String(lesson.stars).padStart(3) + " stars");
  }
writeFileSync(file, JSON.stringify(curriculum, null, 2) + "\n");
