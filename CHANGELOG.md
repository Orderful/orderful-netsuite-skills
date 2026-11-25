# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `whose-turn`: new read-only skill that builds a board of a customer's open trading partners from Orderful, with the stage, who holds the next step, days waiting and the evidence. Flags stale steps on our side, partners to chase and Go-Live Ready partners waiting on cutover.
- `945-fulfillment-debugging`: decoder row and Step 2a for `exceeding the N remaining to fulfill`. The connector fulfills up to NetSuite's default fulfillment quantity, and you can validate that in the UI (e.g. the *Default Items to Zero Received/Fulfilled* preference).
- Initial public release.

<!-- Example entries:

## [1.0.0] - YYYY-MM-DD

### Added
- Feature description.

### Changed
- Change description.

### Fixed
- Bug fix description.

### Removed
- Removed feature description.

### Security
- Security fix description.

-->
