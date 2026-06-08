// Remotion source builders shared by the director and the domain tools.
// Extracted from director.ts so both can import without a cycle (the harness
// tools live under src/tool/ and must not import director.ts, which in turn
// will import the tool registry in Increment E).

import type { Scene, Storyboard } from "./projects.js";

// Build Root.tsx registering ONE <Composition> per scene plus the combined
// "Video" composition, so Remotion Studio lists every slide and renders each
// directly from code (live, hot-reload). Only the scenes passed in are
// imported/registered, so Studio hot-reloads cleanly as slides are written one
// at a time — a scene whose file doesn't exist yet is simply absent.
export function rootSource(sb: Storyboard, scenes: Scene[] = sb.scenes): string {
  const imports = scenes.map((s) => `import {${s.id}} from './scenes/${s.id}';`).join("\n");
  const total = scenes.reduce((n, s) => n + s.durationInFrames, 0);
  const series = scenes
    .map((s) => `      <Series.Sequence durationInFrames={${s.durationInFrames}}>\n        <${s.id} />\n      </Series.Sequence>`)
    .join("\n");
  const perScene = scenes
    .map(
      (s) => `    <Composition
      id="${s.id}"
      component={${s.id}}
      durationInFrames={${s.durationInFrames}}
      fps={${sb.fps}}
      width={${sb.width}}
      height={${sb.height}}
    />`,
    )
    .join("\n");
  const combined =
    scenes.length > 0
      ? `    <Composition
      id="Video"
      component={Video}
      durationInFrames={${total}}
      fps={${sb.fps}}
      width={${sb.width}}
      height={${sb.height}}
    />`
      : "";
  return `import React from 'react';
import {Composition, Series} from 'remotion';
${imports}

export const Video: React.FC = () => {
  return (
    <Series>
${series}
    </Series>
  );
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
${[combined, perScene].filter(Boolean).join("\n")}
    </>
  );
};
`;
}

export function indexSource(): string {
  return `import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';
registerRoot(RemotionRoot);
`;
}
