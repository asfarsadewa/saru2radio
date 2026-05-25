# make-radio-sound

Vendored source for the retro radio preparation tool used by `saru2radio`.

This directory is the copy shipped with `saru2radio`; cloners do not need a
separate `make-radio-sound` repository.

Source note:

- Imported from the author's local `make-radio-sound` project.
- Source commit at import: `c951b01`

If `make-radio-sound` is later published as a standalone public project, update
this note to point at that public canonical source.

The generated Windows executable is intentionally not committed. Build it into
the ignored repo-local tool directory with:

```powershell
npm run setup:radio-sound
```

The setup script writes:

```text
.tools/make-radio-sound/make-radio-sound.exe
```

The CLI shape is:

```text
make-radio-sound.exe INPUT [-o OUTPUT] [--mode am|sw] [--intensity 0..1] [--seed N] [--format mp3|wav]
```

`saru2radio` uses `--mode sw --intensity 0.7 --format mp3` for prepared
radio copies.
