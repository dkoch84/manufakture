# Installing manufakture and working offline

manufakture runs in your browser, and it can also be installed like an app: it then has its own window and icon, and it opens without a network connection. Your documents are saved in the browser either way ([Files](files.md)).

## Installing

- **Chrome and Edge** (Windows, macOS, Linux, ChromeOS): the install icon at the right of the address bar, or the browser menu's **Install manufakture** (in Edge, **Apps**, then **Install this site as an app**).
- **Chrome on Android**: the menu, then **Add to Home screen** or **Install app**.
- **Safari on macOS**: **File**, then **Add to Dock**.
- **Safari on iPhone and iPad**: the Share button, then **Add to Home Screen**.
- **Firefox** does not install web apps on the desktop, but it still keeps manufakture for offline use as described below.

The installed app is the same site: documents saved in the browser tab are there in the app, and the other way round. To remove it, use the app window's menu (**Uninstall manufakture**) or remove it like any other app on your system. Uninstalling keeps your documents; clearing the site's data in the browser settings deletes them, so export anything you need as a `.mfk` file first.

## The first visit

The first time you open manufakture, it downloads the geometry kernel (about 8 MB compressed; the loading screen shows the progress). Once the editor is up, it saves a copy of the whole app for offline use in the background, and a note in the bottom right corner says **Saving for offline use** with the progress, then **Ready to work offline**. You can keep working meanwhile.

## Working offline

After that first visit, manufakture opens with no network at all, from the browser or the installed app: you can open, edit, regenerate, save and export your documents as usual, since everything happens on your machine. One exception: **IFC export** loads its own module the first time it is used, so use it once while online if you will need it offline (and once again after an update).

## Updates

When a new version of manufakture is published, it downloads in the background the next time you open the app (or come back to it). It never replaces the version you are working in by itself. Once all your changes are saved, a note says **A new version of manufakture is ready. Your changes are saved.**, with two buttons:

- **Reload** saves once more and reloads into the new version, with your document open again.
- **Later** keeps the current version until you close every tab and window of manufakture; the new one starts next time.

If your changes cannot be saved at that moment (for example because another tab saved the same document), the note says the new version will be offered once your changes are saved, and waits for that.
