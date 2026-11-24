# Changelog

## 0.1.0

- Add a Translate action to the native action row of every user and assistant message.
- Translate message text into the active interface language through Google Translate.
- Show the translation in a card under the message, with loading, error, retry, and hide states.
- Label the action with Google and name the network or HTTP failure instead of a generic error.
- Announce loading and completion to assistive technology, return focus on close and retry,
  and add an open-state highlight.
- Size a short user-message card to its content instead of the bubble's maximum width.
- Show "Already in …" when the detected language matches the interface language.
- Redesign the in-app translate glyph to match DSH's 1px icon weight and replace the bundle branding icon
  with overlapping source/target speech bubbles harmonized with Session Atlas.
