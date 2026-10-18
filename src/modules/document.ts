/**
 * Text for "read from here": everything from a position in an open document
 * to its end, taken from Zotero's structured document text (see
 * structure.ts). Relies on reader internals (`_internalReader._loadSDT()`),
 * so every failure returns null and callers fall back to the selection.
 */
import {
  collectParagraphs,
  firstOnPage,
  locate,
  textFrom,
  type SDTNode,
} from "./structure";
import { getPref } from "../utils/prefs";

/** A source position, as Zotero passes it in reader events. */
export type SourcePosition = { pageIndex?: number; [key: string]: unknown };

export async function getTextFrom(
  reader: _ZoteroTypes.ReaderInstance,
  position: SourcePosition | null,
): Promise<string[] | null> {
  try {
    const internal = (reader as any)._internalReader;
    if (!internal?._loadSDT) return null;
    const sdt = Components.utils.waiveXrays(await internal._loadSDT());
    if (!sdt?.structure?.content) return null;
    // Copy out of the reader's compartment into plain objects, leaving out
    // per-character geometry (`textMap`), which is most of the size.
    const content = JSON.parse(
      JSON.stringify(sdt.structure.content, (key, value) =>
        key === "textMap" ? undefined : value,
      ),
    ) as SDTNode[];
    const paragraphs = collectParagraphs(content);
    if (!paragraphs.length) return null;

    let start: { index: number; offset: number } | null = null;
    if (position) {
      const target = Components.utils.cloneInto(
        position,
        (reader as any)._iframeWindow,
      );
      const sdtPosition = sdt.mapper?.sourceToSDTPosition?.(target);
      const startRef = sdtPosition?.start
        ? (Array.from(sdtPosition.start) as number[])
        : null;
      if (startRef) start = locate(paragraphs, startRef);
      if (!start && typeof position.pageIndex === "number") {
        start = firstOnPage(paragraphs, position.pageIndex);
      }
    }
    if (!start) {
      const pageIndex = (reader as any).state?.pageIndex;
      start = (typeof pageIndex === "number" &&
        firstOnPage(paragraphs, pageIndex)) || { index: 0, offset: 0 };
    }
    return textFrom(paragraphs, start, {
      stopAtReferences: getPref("stopAtReferences"),
    });
  } catch (e) {
    ztoolkit.log("Structured text unavailable", e);
    return null;
  }
}
