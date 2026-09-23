# [0.2.0](https://github.com/99linesofcode/opencode-beeper-bridge/compare/v0.1.0...v0.2.0) (2026-09-23)


### Features

* detach the bridge itself when its session is no longer active ([#3](https://github.com/99linesofcode/opencode-beeper-bridge/issues/3)) ([667338f](https://github.com/99linesofcode/opencode-beeper-bridge/commit/667338f5a9728b1ffd8c00cd6ca91f616973da9e))



# [0.1.0](https://github.com/99linesofcode/opencode-beeper-bridge/compare/6eed1fe2dc2ec35e50a0aca1e130381c23ac2a9e...v0.1.0) (2026-09-21)


### Bug Fixes

* decode chunked SSE framing byte-accurately ([d22b800](https://github.com/99linesofcode/opencode-beeper-bridge/commit/d22b80022801e33a032578ebccaae418f811fdc8))
* harden the bridge — timeouts, sender policy, bounded resources ([9aa1472](https://github.com/99linesofcode/opencode-beeper-bridge/commit/9aa147252a3ad5f28b9a385f45e9c1f0ad7ae201))
* hold the turn while tools run — publish one message per turn ([e8ae0ba](https://github.com/99linesofcode/opencode-beeper-bridge/commit/e8ae0baa1c7c86c6b38c900d89be58835c82ffd4))
* **lint:** ignore build output ([c8ba45b](https://github.com/99linesofcode/opencode-beeper-bridge/commit/c8ba45b0d53aa8cf1d3e1fc249e25dd0233e4bb7))
* publish on session idle — the turn-completion signal ([ae3188b](https://github.com/99linesofcode/opencode-beeper-bridge/commit/ae3188b0ccefdb9a89cb05fa7abbbd943ec0c59c))
* re-subscribe after an SSE connection closes ([df471e2](https://github.com/99linesofcode/opencode-beeper-bridge/commit/df471e2ca8e7c79ac6c19b7eea685355b6101000))
* verify delivery and retry a dropped send ([6496871](https://github.com/99linesofcode/opencode-beeper-bridge/commit/6496871092160c73420db9e38cef8d99671892bf))


### Features

* bridge beeper chats to pinned opencode sessions ([f421957](https://github.com/99linesofcode/opencode-beeper-bridge/commit/f42195786be95601530a074e6f381db1e6c466d3))
* build as esmodule for nodenext ([e17541f](https://github.com/99linesofcode/opencode-beeper-bridge/commit/e17541ff4609b21e6b3abf5083d8316461bcd57f))
* github actions dependabot workflow ([8b4e02a](https://github.com/99linesofcode/opencode-beeper-bridge/commit/8b4e02ace71a13e2fcd6a247061567548917f154))
* hello world ([6eed1fe](https://github.com/99linesofcode/opencode-beeper-bridge/commit/6eed1fe2dc2ec35e50a0aca1e130381c23ac2a9e))
* load env config and log structured lines ([edc58cf](https://github.com/99linesofcode/opencode-beeper-bridge/commit/edc58cfeda1398c9c3e67762b36beb76329758b0))
* never re-inject the bridge's own replies ([f295309](https://github.com/99linesofcode/opencode-beeper-bridge/commit/f2953097321601b14a02f1bdd6a6c9a500ec463a))
* send only the turn's summary to the chat ([40bd695](https://github.com/99linesofcode/opencode-beeper-bridge/commit/40bd695aa2ef7aeb6ac79b62b0dd65e1dcb067fd))
* speak to the beeper mcp server ([ba76dce](https://github.com/99linesofcode/opencode-beeper-bridge/commit/ba76dcefa3e8424f7798a50ad2abad02bcc48852))
* speak to the opencode unix socket ([41431a6](https://github.com/99linesofcode/opencode-beeper-bridge/commit/41431a6ca1cb26790f36dd79da06df8a09723a76))
* transcribe voice notes locally ([a4b9ede](https://github.com/99linesofcode/opencode-beeper-bridge/commit/a4b9edeb5f389bc29cd7eb914f0390f92e3806a7))



