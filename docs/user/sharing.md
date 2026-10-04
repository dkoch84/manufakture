# Sharing

You can share a model with someone who does not use manufakture, or who should look but not edit: publish a **view** of it. A view is one file holding what the viewport shows, as triangle meshes with the names of their faces and edges, and what you set on the bodies (names, colours, materials) with their volumes and masses. It opens without the geometry kernel and without the editor.

Publishing works offline: it is done in your browser, from the model already on screen, and nothing is sent anywhere. Only [share links](#share-links) upload a view, and only to a server you run yourself.

## Publishing a view

1. Open the part studio or the assembly you want to share.
2. Click **Export** in the header.
3. Tick **Include source** if the person you share with should also get the document itself (see below).
4. Click **Publish view (.mfkview)**.

The file downloads straight away, named after the part studio or the assembly, with the extension `.mfkview`. The header says what was published and how big the file is. A small part is a few kilobytes: the M1 bracket is about 6 KB.

What goes in:

| You are in    | The view holds                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a part studio | the bodies that are shown (hidden [bodies](bodies.md) are left out), each with its name, colour, material, volume and mass                              |
| an assembly   | each part once and every instance where the last solve placed it, named as in the assembly; suppressed instances and instances that failed are left out |

- **Meshes** are the ones the viewport draws, so curved faces are as smooth as they look on screen. The view is for looking and measuring roughly, not for manufacturing: export STEP or 3MF for that (see [Importing and exporting](import-export.md)).
- **Volumes** are exact (the kernel's, as the [Measure](measure.md) tool gives them) where the kernel has the body, else worked out from the mesh. **Masses** are the volume times the material's typical density, so a body without a material has none.
- **Positions** in an assembly are those of the last solve: a drag still going on, or an exploded view, is not published.
- **Names** of faces and edges are the ones features give them; faces with only a temporary name in the viewport are published without one.

### Include source

With **Include source** ticked, the view also carries the document as a `.mfk` file, the same kind of file a document's **Export** on the home screen saves (see [Files](files.md)), as it is on screen and without its named versions. Whoever receives the view can then import the model into manufakture (the `source.mfk` inside the zip, through **Import .mfk**) and edit their own copy. Leave it unticked to share only what the model looks like: the view then holds no sketches, features, variables or history, only the meshes and the metadata above.

## Opening a view

Open the viewer: `viewer.html` next to the app (for example `https://<where the app is>/viewer.html`). It is a small page of its own that shows a view without loading the geometry kernel or the editor, so it opens fast, also on a phone.

- **From a file:** click **Open file** and pick the `.mfkview`, or drop it anywhere on the page.
- **From a link:** a link to a view is the viewer's address with the view's address after `#src=`, for example `https://<viewer>/viewer.html#src=https://files.example.com/bracket.mfkview`. Opening it downloads the view and shows it. See [Links](#links) below.

Once a view is open:

| What        | How                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Look around | the same mouse controls, view cube, standard views (**Front**, **Top**, **Right**, **Iso**, **Fit**) and projection as the app (see [Viewport](viewport.md)) |
| Bodies      | the list on the left, with each body's colour, material, volume and mass; untick a body to hide it, **Show all** brings every body back                      |
| Size        | the size of what is shown along X, Y and Z, in the document's units; tick **Show bounding box** to draw the box                                              |
| Section     | **Section** in the toolbar cuts the view along X, Y or Z, as in the app                                                                                      |
| Measure     | click **Measure distance**, then two points on the model: the straight distance and its X, Y and Z parts; a third click starts again                         |

Measuring works on the meshes, so a point on a curved face is as exact as the mesh drawn, not the exact surface; for exact measurements open the model in manufakture.

### Open in manufakture

When the view carries its source (it was published with **Include source**), the header shows **Open in manufakture**. Clicking it opens manufakture in a new tab and imports the model as a new document of your own, as if you had imported the `.mfk` yourself (see [Files](files.md)). Keep the viewer tab open until the new tab says the model was imported. The model is passed between the two tabs inside your browser; nothing is uploaded. The source is not even unpacked until you click.

### Links

A link carries the view's address in the part after `#`, the fragment. Browsers never send the fragment to a server, so the server that hosts the viewer does not learn which view you open; only the server that holds the view sees the download.

You can put a view on any web server you control and make a link to it yourself:

1. Upload the `.mfkview` file to a server that serves it over **https**.
2. Let the viewer read it: the server must answer with a CORS header that allows the viewer's site, for example `Access-Control-Allow-Origin: *` (anyone may open the link) or `Access-Control-Allow-Origin: https://<viewer site>`. Without it the browser blocks the download and the viewer says it could not read the file. The viewer sends a plain `GET` with no cookies or other credentials, so no `Access-Control-Allow-Credentials` and no preflight are needed.
3. Make the link: `https://<viewer>/viewer.html#src=` followed by the file's full address, as it is. You may also percent-encode the whole address (`https%3A%2F%2F...`); the viewer decodes it.

For example, with nginx:

```nginx
location ~ \.mfkview$ {
    add_header Access-Control-Allow-Origin "*";
    types { application/vnd.manufakture.view+zip mfkview; }
}
```

GitHub Pages sends `Access-Control-Allow-Origin: *` with every file, so a view in a GitHub Pages site works as it is. A host that redirects the download is fine as long as the redirect also goes to an https address.

Or let the app do all of this in one click, through your own manufakture server: see [Share links](#share-links).

### What the viewer refuses

- Links to anything but an `https://` address (or `http://localhost`, only when the viewer itself runs on your own machine), and addresses with a user name or password in them.
- Views larger than **64 MB**, or with more than 500 bodies, 5000 instances or 4 million triangles in all. The download stops as soon as it passes 64 MB. A larger view still opens in manufakture itself: import its `source.mfk`.
- Files that are not views or are damaged: the viewer says what is wrong and keeps showing the view that was open.

### Offline

The viewer is part of the installed app (see [Install](install.md)): after manufakture has been opened once in the browser, `viewer.html` also opens offline, and a view from a file works without a network. A link needs the network to download its view.

## Share links

A share link is a [link](#links) made in one step: **Share** publishes the view, uploads it to your own manufakture server, and gives you the link. Whoever has the link can open the view in the viewer, with no account and no token; nobody can list or find links they were not given. You can revoke a link at any time.

There is no hosted manufakture service: share links need a server you run (the `apps/server` program, see its README). One server has one token and one user.

### Setting up the server

1. Run the server and put it behind https (its README, "Routing `/api` to the server", shows how).
2. Set `MANUFAKTURE_ORIGINS` to the address of the app you use, so the app may talk to the server. The viewer is allowed to download shares from the same addresses, unless you set `MANUFAKTURE_VIEWER_ORIGINS` to the viewer's own.
3. In the app, click **Share** in the header, enter the server's address (`https://...`, without `/api`) and its token (`MANUFAKTURE_TOKEN`), and click **Save**. The address and token are kept in this browser only, never in a document or a file. **Forget** removes them.

### Making a link

1. Open the part studio or assembly, as for [publishing](#publishing-a-view).
2. Click **Share**. Pick when the link **Expires** (30 days unless you choose otherwise, or **never**), and tick **Include the document** if whoever opens the link should be able to edit a copy (see [Include source](#include-source)).
3. Click **Create link**. The link appears in the panel and is copied when the browser allows it; **Copy** copies it again.

The link has the shape `https://<viewer>/viewer.html#src=https://<server>/api/shares/<id>`. The id is 128 random bits, so links cannot be guessed. The view that was uploaded is a snapshot: later edits to the model do not change it; share again for a new one.

**Active links** lists the links the server still holds, with their size and expiry. **Revoke** deletes the view from the server; the link stops working at once (the server tells browsers not to keep a copy). An expired link is deleted the same way the next time anyone asks for it, lists the links or makes a new one.

### Limits

The server ships with these defaults; whoever runs it can change each one:

| Limit                          | Default   | Setting                                     |
| ------------------------------ | --------- | ------------------------------------------- |
| Largest view                   | 50 MB     | `MANUFAKTURE_SHARE_MAX_BYTES` (bytes)       |
| Active links per token         | 100       | `MANUFAKTURE_SHARE_MAX_COUNT`               |
| Expiry when none is picked     | 30 days   | `MANUFAKTURE_SHARE_EXPIRY_DAYS`             |
| Links that never expire        | allowed   | `MANUFAKTURE_SHARE_ALLOW_NEVER=off` forbids |
| Downloads served at once       | 8         | `MANUFAKTURE_SHARE_MAX_CONCURRENT_READS`    |
| Origins the viewer may read at | the app's | `MANUFAKTURE_VIEWER_ORIGINS`                |
| Share links at all             | on        | `MANUFAKTURE_SHARES=off` turns them off     |

A view over the size limit is refused before it is uploaded; the server also stops reading an upload as soon as it passes the limit. When the server holds as many links as it allows, revoke one first.

### If you run the server

Share links are the one part of the server anyone can reach without the token: `GET /api/shares/<id>`. Things to know:

- **You are responsible for what your server hosts.** It is your server and your token: manufakture offers no hosted service and no takedown address. Whoever has your token can publish views through your server, so keep it secret.
- Downloads are answered with a type no browser displays (`application/vnd.manufakture.view+zip`), as an attachment, with `X-Content-Type-Options: nosniff`, a `Content-Security-Policy` that allows nothing, and `Cache-Control: no-store`. Unknown, revoked and expired ids get the same 404. CORS allows only the viewer's origins, without credentials.
- Views are stored in the server's SQLite database. Revoking deletes the row; SQLite may keep the freed bytes in the file until it reuses the space or you run `VACUUM`, and in backups you made before.
- The server limits how many downloads run at once, but not how often one address may ask. Put a rate limit in your reverse proxy if your server is reachable by the public, and make sure the proxy allows request bodies up to the size limit (nginx: `client_max_body_size`).

## Safety

A view you receive is untrusted, and the viewer treats it so: it reads only the entries the format defines, checks every field and every mesh against the limits above before anything uses it, and shows every name as plain text, with invisible direction-changing and control characters removed, so a name cannot pretend to be something else. A file that is damaged, too large or not a view is refused with a message saying why. A source `.mfk` inside a view is checked again, like any `.mfk` you import, when it is opened in manufakture.
