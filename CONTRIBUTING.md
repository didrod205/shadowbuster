# Contributing to ShadowBuster

Thanks for helping make "hidden but not removed" content visible before it leaks.

## Principles (please keep these)

1. **Zero runtime dependencies.** The engine uses only platform APIs (`DecompressionStream`, `DataView`, `TextDecoder`, Node built-ins). A dependency-free tool is one people can actually audit before trusting it with a sensitive file. Dev dependencies (TypeScript, Vite, Vitest) are fine.
2. **Nothing leaves the machine.** No telemetry, no network calls, no uploads — in the library, the CLI, or the web page.
3. **No false guesses.** If something can't be decoded reliably, report it as undecodable. A confident wrong answer is worse than "couldn't read this."
4. **Awareness, not exploitation.** ShadowBuster surfaces what a document already exposes to anyone who opens it. Keep framing and features on the defensive side.

## Dev setup

```bash
npm install
npm run fixtures     # regenerate sample files (needs python3, stdlib only)
npm test             # vitest against the fixtures
npm run typecheck
npm run dev          # the playground at web/
npm run build        # library + CLI (tsup)
npm run build:web    # static site -> docs/
```

## Adding a detector

1. Add the logic to the right module in `src/` (`pdf.ts`, `ooxml.ts`, `image.ts`) and return `Finding`s.
2. Give it a stable `kind`, a clear `title`, an honest `summary`, and a `severity`.
3. Add a fixture in `scripts/make_fixtures.py` that demonstrates it, regenerate, and assert on it in `tests/`.
4. Keep the recovered payload faithful — don't reformat it into something that looks scarier than it is.

Good candidates: PDF annotation/form-field values, EXIF/GPS in embedded images, DOCX `customXml`/`settings.xml` leftovers, ODF (`.odt`/`.ods`) formats, SVG metadata.

## License

By contributing you agree your work is licensed under the MIT License.
