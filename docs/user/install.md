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

While the browser has no network connection, a small **Offline** note sits in the bottom left corner. Nothing else changes: your documents still save in the browser. Only looking for a new version waits until you are back online.

## Keeping your documents

Browsers may delete a website's stored data, documents included, when the disk runs low on space. They leave it alone when the site has asked to be kept and the browser has agreed ("persistent storage"). manufakture asks after your first save, and again when you install it (or when it first opens in its own app window) if the browser said no the first time: some browsers decide by themselves and agree more readily for an installed app (Chrome), and some ask you (Firefox). manufakture remembers the answer and, after that, does not ask again by itself. When the browser offers no storage at all (documents are then lost when the page closes), it does not ask.

The bottom of the home screen says whether the browser keeps your documents. When it does not, **Keep my documents** asks again. When the browser declined, the home screen says so: the documents stay in the browser and work as usual, but a browser short of space may delete them without asking.

What eviction means:

- **It is all or nothing.** The browser deletes everything the site stored at once: every document, its history and versions, and the offline copy of the app. You will not find half a document.
- **It does not ask, and nothing can bring the data back.** The next time you open manufakture, the home screen simply lists no documents (and, offline, the app may not open until you are online again to download it).
- **Persistent storage protects against eviction, not against you.** Clearing the site's data in the browser settings, or a "clean up" tool, still deletes it, persistent or not.
- **A `.mfk` file is the only copy outside the browser.** Export the documents you care about (**Export** on the home screen) and keep the files somewhere backed up, especially when the browser declined to keep your documents, and before clearing browser data. Importing the `.mfk` file brings the document back as it was saved (its edit history stays behind).

## Updates

When a new version of manufakture is published, it downloads in the background the next time you open the app (or come back to it). It never replaces the version you are working in by itself. Once all your changes are saved, a note says **A new version of manufakture is ready. Your changes are saved.**, with two buttons:

- **Reload** saves once more and reloads into the new version, with your document open again.
- **Later** keeps the current version until you close every tab and window of manufakture; the new one starts next time.

If your changes cannot be saved at that moment (for example because another tab saved the same document), the note says the new version will be offered once your changes are saved, and waits for that.

### Other tabs

If manufakture is open in several tabs or windows and you choose **Reload** in one of them, the new version takes over the others too, but they keep running the version they started with until reloaded. Each of them then says **manufakture was updated in another tab**, with **Reload** (offered once its changes are saved, as above). Reload them when convenient: until you do, a part of the app a tab has not used yet (a dialog, an exporter) may fail to load. If that happens, the note says **Part of manufakture could not be loaded** and offers Reload as well; your changes are saved first.

### A document from a newer version

A document saved by a newer version of manufakture (on another computer, or imported as a `.mfk` file) cannot be opened by an older one: it is refused and left exactly as it is, never changed. The home screen then says that the document needs a newer version, with **Update the app**:

- If a newer version is available, it downloads, and once your changes are saved, **Reload** starts it. Then open the document again.
- If the site has no newer version yet, it says so: open the document in the version that saved it, or try again later.
- Offline, it says it cannot reach the site; connect and choose **Try again**.
