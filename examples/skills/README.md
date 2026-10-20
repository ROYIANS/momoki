# Portable creative workflow examples

These directories contain text-only examples for the local skill importer.
Choose one directory (for example `media-intake`), review the captured files in
Agent → plus menu → Skills → Manage skills, and explicitly enable it if wanted.
Examples are never automatically installed or enabled.

Each package uses a root `SKILL.md` and optional text under `references/` or
`assets/`. The directory and frontmatter `name` must match. Momoki supports
UTF-8 Markdown, plain text, JSON, YAML and CSV resources; scripts, executable and
binary resources are excluded. Editing these source files does not update an
installation: select the directory again through the manual update review.

The first model request contains only the enabled catalogue. `load_skill` reads
one captured body, and `read_skill_resource` reads a selected reference page after
that load. Skill content is workflow guidance; builtin tool switches, actual
desktop availability, project ownership and approval rules still decide what
can execute. An existing run keeps its original installed revision.

`media-intake` demonstrates the existing desktop video import workflow. Native
directory selection requires macOS or Windows; Windows sources initially require
a local fixed NTFS volume. This example is not evidence that installed system
picker or media acceptance has run on either platform.
