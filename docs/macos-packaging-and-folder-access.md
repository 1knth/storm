# macOS packaging and folder access

## Verify a packaged app signature

Unsigned macOS development packages receive an ad-hoc signature after packaging so the bundle's code signature and Electron bundle identifier agree. A configured signing identity or `osxSign` configuration is left to Electron Packager; the fallback does not replace production signing. If signing or strict verification fails, packaging fails rather than emitting a package that appears successful.

To inspect a packaged app, run:

```sh
codesign --verify --deep --strict --verbose=2 /path/to/Storm.app
codesign -dv --verbose=4 /path/to/Storm.app 2>&1
```

Ad-hoc signing is not Developer ID signing and does not notarize an app or remove Gatekeeper warnings. Distribution builds should use the project's configured signing and notarization credentials.

## Select a vault folder

Choose **Request folder access…** to reopen the native folder picker and select the vault again. This is not a Storm-created “Allow access” dialog. macOS controls Files & Folders/TCC permission prompts and may not show one for every selection; Storm cannot force a prompt to appear. If access still fails, use macOS System Settings → Privacy & Security → Files & Folders when Storm is listed, and review the error shown by the app. Re-selecting a folder does not make an underlying `EPERM`/permission error succeed silently.
