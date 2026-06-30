// Public API. The whole engine is pure and dependency-free: give it bytes, get
// back a list of things that were hidden in the file but never removed.

export { scanBytes } from "./scan.js";
export { analyzePdf } from "./pdf.js";
export { analyzeOoxml } from "./ooxml.js";
export { analyzeImage } from "./image.js";
export { openArchive } from "./zip.js";
export type {
  ScanResult,
  Finding,
  Severity,
  FileKind,
  Recovered,
  RecoveredText,
  RecoveredImage,
} from "./types.js";
