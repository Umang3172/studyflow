import { useEffect, useId, useRef, useState } from "react";
import { ganttSource, type GanttItem } from "@studyflow/shared";

// Mermaid is large, so it is only imported when a plan is under review. strict mode sanitises the SVG,
// and the source is built by ganttSource() from plan data with labels reduced to a safe character set.
export function Gantt({ items }: { items: GanttItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const id = "g" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [failed, setFailed] = useState(false);
  const source = ganttSource(items);

  useEffect(() => {
    let alive = true;
    (async () => {
      const mermaid = (await import("mermaid")).default;
      const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
        gantt: { useMaxWidth: false, fontSize: 11, sectionFontSize: 11, barHeight: 16, barGap: 3, leftPadding: 8, topPadding: 28 },
      });
      const { svg } = await mermaid.render(id, source);
      if (alive && ref.current) ref.current.innerHTML = svg;
    })().catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [source, id]);

  if (failed) return <p className="text-xs text-muted-fg">Timeline preview unavailable; the session list below has everything.</p>;
  return <div ref={ref} className="overflow-x-auto" role="img" aria-label="Study timeline chart" />;
}
