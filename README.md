# dsh-message-translate

[简体中文](README.zh.md)

Adds a Translate action under each message; clicking sends that message to Google Translate and shows the result.

## Install

Requires DeepSeek Harness 0.2.2-rc.5 or newer.

Run `npm install` in this directory, then choose it in **Plugins** > **Add plugin** or pass it to `install_bundle`.
The bundle appears as **Message translation**; disable it in **Plugins** to remove the buttons.

## Use

Hover an earlier message, or look under the latest answer, for the translate icon in the native action row.
Click it to request a translation into the current interface language.
The result appears in a card under the message and stays until you hide it.
The card names the detected source language and the target.

The button appears on finalized messages that contain text.
A streaming reply gets it when the reply settles, and messages without text have no button.

## Limits

- The target follows the DSH interface language; there is no per-message target picker yet.
- The browser must reach `translate.googleapis.com`.
  Corporate proxies or offline use fail with an inline retry action.
- Clicking sends that message's text to Google.
  Nothing leaves the machine before the click.
- Code blocks are translated as ordinary text, so identifiers inside them are not preserved.
- The result renders as plain text; Markdown syntax stays literal instead of being re-rendered.
- A message already in the interface language shows an "Already in …" note instead of repeating itself.

[Project documentation](docs/README.md)
