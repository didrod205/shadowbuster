// The shared result model. Every analyzer (pdf, ooxml, image) turns a dropped
// file into a list of Findings — things that are physically present in the file
// but were meant to be gone or invisible.

export type Severity = "critical" | "warning" | "info";

export type FileKind =
  | "pdf"
  | "xlsx"
  | "docx"
  | "pptx"
  | "ooxml"
  | "png"
  | "jpeg"
  | "unknown";

/** Recovered text that was hidden but never removed. */
export interface RecoveredText {
  type: "text";
  text: string;
}

/** A recovered image — e.g. the uncropped original behind a crop. */
export interface RecoveredImage {
  type: "image";
  /** MIME type, e.g. "image/png". */
  mime: string;
  /** Raw bytes of the embedded image, ready to render or download. */
  bytes: Uint8Array;
  /** True when the document only displayed a cropped portion of this image. */
  cropped?: boolean;
}

export type Recovered = RecoveredText | RecoveredImage;

export interface Finding {
  /** Stable machine id, e.g. "pdf.redaction" or "xlsx.very-hidden-sheet". */
  kind: string;
  /** Short human title shown as the headline of the card. */
  title: string;
  severity: Severity;
  /** One-line plain-English explanation of what leaked and why. */
  summary: string;
  /** Where it was found, e.g. "page 2" or "sheet \"Q3 bonuses\"". */
  location?: string;
  /** The actual recovered payload, if any. */
  recovered?: Recovered;
}

export interface ScanResult {
  fileName: string;
  kind: FileKind;
  /** Bytes scanned. */
  size: number;
  findings: Finding[];
  /** Non-fatal diagnostics: encryption, unsupported encodings, etc. */
  notes: string[];
}

export function emptyResult(fileName: string, kind: FileKind, size: number): ScanResult {
  return { fileName, kind, size, findings: [], notes: [] };
}
