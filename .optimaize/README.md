# `.optimaize/` — project configuration

This hidden folder holds OptimAIze-VideoMaker's project config. It is a dot-folder,
so use `ls -a` to see it.

## Layout

```
.optimaize/
  skills/
    video-skills/         # the shipped skill (ready to use)
      SKILL.md            # always-on core guidance, injected into every LLM prompt
      rules/
        <topic>.md        # on-demand rules, loaded per scene by keyword match
        assets/           # code samples referenced by rules
```

## Add or customize a skill

Copy the shipped skill as a starting point:

```bash
cp -r .optimaize/skills/video-skills .optimaize/skills/my-skill
```

Then edit `SKILL.md` (the YAML frontmatter `name`/`description` show in the app's
Settings panel) and add focused `rules/*.md`.

## How skills reach the LLM

- `SKILL.md` (minus frontmatter) is injected into **every** authoring, scene,
  repair, and chat prompt — keep it short and high-signal.
- `rules/*.md` are pulled in **on demand**: the director scores each rule's
  filename keywords against the scene and injects the top matches (size-capped).
- The active skill is shown in **Settings**, and exposed via
  `GET /api/v1/vm/skills` and `GET /api/v1/vm/skills/rule?name=<file>`.
