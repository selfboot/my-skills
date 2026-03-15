# Adding A Platform

Add a new platform in three places:

1. Register the platform in [scripts/platforms.ts](../scripts/platforms.ts).
2. Add or adjust browser config for login, editor opening, selectors, and save/publish controls.
3. Test with a short markdown article before claiming the platform is ready.

## Browser Adapter

Every current platform uses the shared browser publisher. Prefer extending config before writing a dedicated script.

Required config:

- `homeUrl`
- `editorUrl`
- `urlPattern`
- `loginKeywords`
- `loggedInUrlIncludes` when URL state is a more reliable login signal than page text
- `openStrategy` when the editor cannot be opened by direct URL alone
- `titleSelectors`
- `titleInputMode`
- `authorSelectors` and `authorInputMode` when author is editable
- `editorSelectors`
- `summarySelectors`
- `summaryInputMode`
- `bodyTextSelector` when body verification should use a narrower selector
- `saveDraftTexts`
- `saveDraftSelector` when button text is unstable
- `publishTexts`
- `publishSelector` when button text is unstable
- `confirmPublishTexts` or `confirmPublishSelector` when the platform shows a second confirm step
- `profileDir`

## What Usually Breaks

- Editor selectors become stale after a frontend redesign.
- The editor is opened from a dashboard menu rather than a direct URL.
- Save/publish button text changes.
- The title field becomes a shadow DOM or iframe field.
- The platform introduces captcha, slider, or extra risk checks.

When config is no longer enough, add a dedicated script inside this skill rather than delegating to an external skill.
