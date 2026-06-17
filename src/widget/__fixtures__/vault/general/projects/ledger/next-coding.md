---
type: project
project: ledger
subtype: coding
status: active
---
1. First finalization track
	- Checkpoint written into a neutral reference
	- Final product lands at `sample-repo\z_docs\sample-reference.md`; extends a locked-in formula Ann ROI = (net / collateral) × (365 / DTE) to all variants. (Sun 6/14/26)
	- Confirm a neutral annualized-math placeholder ($1 → $16.42, 10.16% annualized) matches our calculation; see [[wiki/sources/sample-source-part-1]] (Sat 5/16/26)
2. Backtesting API
	- Turn the result into a proxy and compare to the current chain
	- Heatmaps: X (y-axis) vs Y (x-axis) showing a probability surface
3. 2027 prep
	- Link: [[sample-2027-brain-dump]]
	- Make the sheet the "dumb data entry layer" — all calcs move to the dashboard, see **spec-030**: port calculation logic (Wed 5/13/26). Spec path: `z_docs/spec-030.md`
4. API setup
	- [API docs](https://example.com/apis/docs) — get set up for a neutral automation goal
5. Dashboard fixes
	- Add a neutral date field to active rows
	- Fix filter labels rolling over on mobile
6. Principles/Primitives file
	- [[!principles]]
	- A neutral two-part note about the principles file: 1. naming, 2. examples
7. Token refresh from mobile
	- The following needs to be built:
	- There wasn't a web-accessible trigger before — only a desktop terminal method
	- The code adds two new endpoints:
		- ∙ GET /api/tokens/auth-url — didn't exist before
		- ∙ POST /api/tokens/refresh — didn't exist before
	- Without those there's no mobile path short of SSH
8. Security considerations
	- Can we rotate the key? encryption=YOUR_SAMPLE_KEY
	- Document how to access logs
