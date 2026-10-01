# Slicer hand-off and 3MF interop: research for M3

- Status: research, input to the [M3 plan](../plans/m3.md)
- Date: 2026-09-26; command-line checks added 2026-10-01 ([section 6](#6-verified))
- Question: how does a local-first web app (no server until M7, [product decisions](../decisions/0000-product-decisions.md)) get a part into OrcaSlicer, Bambu Studio or PrusaSlicer with as few steps as possible, and what must its 3MF contain so that parts, names and colours arrive intact?

## Method and conventions

The three slicers are open source, so their behaviour was read from their source at their latest release tags rather than from forum posts:

| Slicer       | Release read    | Published  | License  | Repository                                                        |
| ------------ | --------------- | ---------- | -------- | ----------------------------------------------------------------- |
| OrcaSlicer   | `v2.4.2`        | 2026-07-07 | AGPL-3.0 | [OrcaSlicer/OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) |
| Bambu Studio | `v02.08.02.61`  | 2026-08-21 | AGPL-3.0 | [bambulab/BambuStudio](https://github.com/bambulab/BambuStudio)   |
| PrusaSlicer  | `version_2.9.6` | 2026-06-25 | AGPL-3.0 | [prusa3d/PrusaSlicer](https://github.com/prusa3d/PrusaSlicer)     |

Release tags, dates and licenses are from the GitHub API on 2026-09-26.

- **Checked** means the statement was read in the source file linked next to it, at that tag.
- **Unverified** means it was not read in source or tried by hand; the M3 spike tries each one (T3.0a in the plan for what a slicer's command line can show, T3.0d for the checks a person makes in the slicers' GUIs and browsers).
- All three slicers are AGPL-3.0. [ADR 0006](../adr/0006-licensing.md) excludes AGPL code from this repository, so their sources were read for behaviour only. Nothing from them may be copied into manufakture; we interoperate through files and URLs, which the license does not reach.

## 1. URL schemes

All three slicers register a custom URL scheme whose `open` command takes a `file` parameter holding an **HTTP URL of the model**. The slicer process then downloads that URL itself with its own HTTP client (libcurl) and loads the downloaded file. None of them accepts file contents in the URL, and none documents a local path form.

### OrcaSlicer 2.4.2

- **Forms accepted.** `Downloader::start_download` ([`src/slic3r/GUI/Downloader.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/Downloader.cpp)) matches `^(orcaslicer|prusaslicer|bambustudio|cura)://open/?\?file=` (case-insensitive) or `^bambustudioopen://`, takes everything after the match as the download URL and URL-decodes it with `curl_easy_unescape` (`FileGet::escape_url` in [`DownloaderFileGet.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/DownloaderFileGet.cpp)). Checked. So `orcaslicer://open?file=https%3A%2F%2Fexample.org%2Fpart.3mf` is the canonical form; Thingiverse's button uses exactly this shape (`orcaslicer://open?file=https%3A%2F%2Fwww.thingiverse.com%2Fdownload%3A14134689`, quoted in [PR #8377](https://github.com/OrcaSlicer/OrcaSlicer/pull/8377)).
- **Which scheme reaches Orca.** Orca parses the `prusaslicer`, `bambustudio` and `cura` prefixes too, but the operating system only routes a scheme to Orca if Orca registered it. On Windows Orca calls `associate_url(L"orcaslicer")` on every start of the editor ([`GUI_App.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/GUI_App.cpp), checked); on Linux its `.desktop` file declares `x-scheme-handler/orcaslicer` since [PR #8377](https://github.com/OrcaSlicer/OrcaSlicer/pull/8377) (merged 2025-02-12, checked); on macOS it installs its own Apple-event handler "so orcaslicer:// deep links keep working after the wxWidgets 3.3.2 upgrade" (`register_mac_deep_link_handler`, checked). Only `orcaslicer://` is registered by Orca itself.
- **No host allowlist.** The download path in `Downloader.cpp` does not check the host: `FileGet::is_subdomain` is defined in `DownloaderFileGet.cpp` but not called from either downloader file (checked by reading both; a call elsewhere in the tree was not searched for). MakerWorld links are routed to a separate MakerWorld importer; every other URL is fetched as a plain download.
- **http and https.** Nothing requires `https://`. Orca's `Http` class turns TLS peer and host verification off by default (`CURLOPT_SSL_VERIFYPEER 0`, `CURLOPT_SSL_VERIFYHOST 0` in [`src/slic3r/Utils/Http.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/Utils/Http.cpp), checked), and sets no `CURLOPT_PROTOCOLS` restriction. Orca's bundled curl build disables LDAP, RTSP, DICT, TELNET, POP3, IMAP, SMB, SMTP, GOPHER, TFTP and MQTT but not FILE ([`deps/CURL/CURL.cmake`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/deps/CURL/CURL.cmake), checked), so a `file://` URL may be read by curl. Unverified: not tried, and Linux distribution builds may link the system curl instead.
- **File name and format.** The file name is the URL's last path segment (`filename_from_url` in `Downloader.cpp`), replaced by a `Content-Disposition: ... filename="..."` header when the server sends one (`extract_remote_filename`); the format follows from the extension. So the URL must end in `.3mf` or the server must name the file. Checked.
- **Preconditions.** The download goes to the configured download folder; if none is set, Orca shows "Could not start URL download. Destination folder is not set" and stops (`GUI_App::start_download`, checked). Downloads are capped at 1 GiB (`DOWNLOAD_SIZE_LIMIT`, checked).

### Bambu Studio 2.8.2

- **Forms accepted.** On Windows and Linux the URL arrives as a command-line argument: `bambustudio://open?file=<url>` is URL-decoded and split on `file=` ([`GUI_App.cpp`](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/slic3r/GUI/GUI_App.cpp), `post_init`, checked). On macOS `MacOpenURL` handles `bambustudioopen://<url-encoded url>` instead, and only proceeds for a decoded URL starting with `http://` or `https://` (checked). The Linux `.desktop` file declares `x-scheme-handler/bambustudio` ([`BambuStudio.desktop`](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/platform/unix/BambuStudio.desktop), checked). How the Windows installer registers the scheme was not read (unverified).
- **Trusted hosts, with a prompt for the rest.** In public release builds (`BBL_RELEASE_TO_PUBLIC`), a URL is trusted when it starts with `http://makerworld` or `https://makerworld` or `http(s)://public-cdn.bblmw.com`, or merely **contains** `amazonaws.com` or `aliyuncs.com` anywhere. Any other URL shows "This file is not from a trusted site, do you want to open it anyway?" and is opened only on Yes. Checked in both code paths. So a third-party URL works, at the cost of one confirmation.
- **Sanitising.** `sanitize_download_url` strips `../` and `./` sequences from the URL before use (checked).
- Background: users have asked for the MakerWorld-only restriction to be lifted ([issue #6120](https://github.com/bambulab/BambuStudio/issues/6120)); the prompt above is how 2.8.2 handles other sites.

### PrusaSlicer 2.9.6

- **Forms accepted.** `prusaslicer://open?file=<url>` or `prusaslicer://open/?file=<url>`, URL-decoded first ([`Downloader.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/slic3r/GUI/Downloader.cpp), checked).
- **Strict allowlist.** The decoded URL must start with `https://` and its host must be `printables.com`, `testprusaverse.com`, `thingiverse.com` or `cults3d.com`, or a subdomain of one; otherwise the notification "Download won't start. Download URL doesn't point to allowed subdomains" appears and nothing is fetched. Checked. There is no user setting to add hosts; users have asked for one ([issue #13752](https://github.com/prusa3d/PrusaSlicer/issues/13752), [issue #14313](https://github.com/prusa3d/PrusaSlicer/issues/14313)).
- **Opt-in.** The URL is ignored unless the user enabled "Allow built-in downloader" in the configuration wizard or "Allow downloads from supported websites" in the preferences (`downloader_url_registered` in [`GUI_App.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/slic3r/GUI/GUI_App.cpp), checked for the macOS URL path; the setting names are from [Prusa's knowledge base](https://help.prusa3d.com/article/opening-models-in-prusaslicer-from-supported-websites_399198), which also says the feature exists since 2.6.0).
- **Adding a domain.** Prusa: "We welcome other model providers to integrate the feature. Our policy is to whitelist new domains following a brief security review" ([knowledge base](https://help.prusa3d.com/article/opening-models-in-prusaslicer-from-supported-websites_399198)). A self-hosted or local-first app has no fixed domain to review.

### Other schemes seen

- **Cura.** Orca accepts `cura://open?file=` syntax, which says something about the ecosystem but nothing about Cura itself. Cura's own handler was not read (unverified), and Cura is not a target ([product decisions](../decisions/0000-product-decisions.md)).
- **Bambu Connect** documents `bambu-connect://import-file?path=...&name=...&version=1.0.0`, where `path` is an **absolute local path** to an already sliced `.gcode.3mf` ([Bambu Lab wiki, third-party integration](https://wiki.bambulab.com/en/software/third-party-integration)). It is meant for slicers sending finished jobs to a printer. It does not fit us: we hand off unsliced models, and a web page cannot know a local path (next section).

### Summary

| Slicer (release)   | Scheme a page would use    | Host rule                                                          | https required | User setting needed           |
| ------------------ | -------------------------- | ------------------------------------------------------------------ | -------------- | ----------------------------- |
| OrcaSlicer 2.4.2   | `orcaslicer://open?file=`  | none                                                               | no             | a download folder must be set |
| Bambu Studio 2.8.2 | `bambustudio://open?file=` | MakerWorld and two CDNs trusted; any other host asks the user once | no             | none                          |
| (macOS)            | `bambustudioopen://<url>`  | same                                                               | http or https  | none                          |
| PrusaSlicer 2.9.6  | `prusaslicer://open?file=` | printables, thingiverse, cults3d only; refused otherwise           | yes            | downloader must be enabled    |

## 2. What a local-first web app can hand over

Every scheme above ends with the slicer's own HTTP client fetching a URL. The question is therefore whether a page with no server can produce a URL that another process on the same machine can fetch.

- **A `blob:` URL cannot work.** The File API: "Blob URLs can only be fetched from environments where the storage key matches that of the environment where the blob URL was created", and a document's blob URLs are removed from the store when it is cleaned up ([W3C File API, sections 8.3.2 and 8.3.3](https://w3c.github.io/FileAPI/)). A slicer is not a browser environment at all; the URL means nothing outside the browser.
- **A `data:` URL** would carry the file itself in the link. libcurl, which all three slicers use, has no `data:` handler, and the slicers take the file name from the URL's last path segment, which a data URL does not have. Not tried (unverified), but there is no code path that would accept it.
- **A service worker cannot serve it.** A service worker intercepts requests from its own clients (pages of its origin in that browser); the slicer's HTTP request never passes through the browser.
- **A `file://` URL** needs the absolute path of the saved file. The web platform never exposes it: a download lands wherever the browser puts it, and File System Access API handles expose names, never paths. So even though OrcaSlicer might read `file://` through curl (section 1, unverified), a page cannot build the URL. PrusaSlicer refuses it outright (https only) and Bambu Studio's macOS path requires http or https.
- **A local server is not available.** A page cannot listen on a socket. Anything that could (a companion program, a local daemon) is a server, which the product decisions rule out until M7, and a native helper would also have to be installed, signed and updated per operating system.
- **A hosted https URL would work, but needs a server.** With a server (M7), the app could upload the 3MF to a short-lived, unguessable URL ending in `.3mf` and navigate to `orcaslicer://open?file=<that URL>`. From section 1: OrcaSlicer would fetch it with no prompt; Bambu Studio would ask "not from a trusted site" once per link; PrusaSlicer would refuse unless the host were allowlisted by Prusa. It also means uploading the user's model, which a local-first app must never do silently: it needs an explicit opt-in per use or per document.

What happens in the browser when a page navigates to a custom scheme matters for the M7 option too. Browsers ask before handing a URL to an external application, and when no application is registered the navigation fails with no event the page can observe; Firefox logs "Prevented navigation to "orcaslicer://..." due to an unknown protocol" (quoted in [PR #8377](https://github.com/OrcaSlicer/OrcaSlicer/pull/8377)). There is no web API to ask whether a scheme has a handler (general browser behaviour, not tested per browser: unverified). A scheme link can therefore never be the only way out; the download must always be offered next to it.

### What does work today: download, then open

- **Download the 3MF** with a clear name. It lands in the user's downloads folder, and from there any slicer opens it (File, Import, or drag onto the plate). This works in every browser and for every slicer, with no setup.
- **Open from the browser's download list.** Every desktop browser lets the user open a finished download with the system's default application. OrcaSlicer on Windows associates `.3mf` with itself when its `associate_3mf` preference is on (`associate_files(L"3mf")` in `GUI_App.cpp`, checked), so the second click opens Orca directly.
- **Open automatically.** Chrome can open every download of a type automatically ("Always open files of this type"; administrators can set the list with the [`AutoOpenFileTypes` policy](https://chromeenterprise.google/policies/auto-open-file-types/), which says auto-opened files still go through Safe Browsing checks). Whether Chrome offers that choice for `.3mf` was not tried (unverified). If it does, "export for printing" becomes one click after a one-time choice.
- **Save into a chosen folder.** In Chromium browsers `showSaveFilePicker` can save into a folder the user picks once (a print queue folder, say). It does not launch the slicer and is Chromium-only, so it is at most an option.

## 3. What each slicer reads from a 3MF

### The specifications

- **Core** (what `packages/io` writes today, [io README](../../packages/io/README.md), "3MF"): mesh objects, names, `unit="millimeter"`, build items. The core spec also defines `<basematerials>` with a `displaycolor` per material.
- **Materials and Properties extension**, version 1.2.1, namespace `http://schemas.microsoft.com/3dmanufacturing/material/2015/02` ([spec](https://github.com/3MFConsortium/spec_materials/blob/master/3MF%20Materials%20Extension.md)): `<colorgroup id>` holding `<color color="#RRGGBB[AA]">`; an object references a property group with `pid` and an index with `pindex`, and a triangle may override them with `pid`, `p1`, `p2`, `p3`.
- **Production extension**, version 1.2, namespace `http://schemas.microsoft.com/3dmanufacturing/production/2015/06` ([spec](https://github.com/3MFConsortium/spec_production/blob/master/3MF%20Production%20Extension.md)): `p:UUID` on objects, build and items, and `p:path` so a component can live in another model part. It matters for splitting a package into several model files, which we do not need.

### OrcaSlicer 2.4.2

Read from [`src/libslic3r/Format/bbs_3mf.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/Format/bbs_3mf.cpp) (checked unless marked):

- **Colours: object-level colour groups, literal prefix `m`.** The reader matches the element names `m:colorgroup` and `m:color` as literal strings (raw tag names, prefix included), so the materials namespace must be declared with the prefix `m`. For each group it records a colour (`m_group_id_to_color[group] = color`), so a group with several colours keeps only its **last** one. After loading it numbers the distinct colours 1, 2, 3 in group order and sets each object's `extruder` from its object-level `pid`. `pindex` and per-triangle `pid`, `p1` to `p3` are not used. So: **one colour group per distinct colour, one colour in each, and `pid` on the object** is what Orca turns into filament slots.
- **Filament colours are not taken from the file** as far as the loader shows: the colour decides the slot number, not the slot's colour. **Confirmed on the command line** (section 6: after loading, the project keeps Orca's one default filament colour); what the GUI shows is T3.0d's check.
- **Bambu and Orca project files are detected by metadata.** A file whose `Application` metadata starts with `BambuStudio-` or `OrcaSlicer-`, or that carries an `OrcaSlicer` metadata entry, is treated as a Bambu-format project: its `Metadata/model_settings.config` must then be valid ("Archive does not contain a valid model config" otherwise) and its project settings are loaded. **A third-party file must not claim one of those application names**; ours says `manufakture`.
- **For other producers' files**, Orca still parses `Metadata/model_settings.config` when present, ignoring errors, and it splits an object with several build items into one object per item, and names a lone object after the file. Per-object `extruder` metadata from `model_settings.config` **is applied** for a non-Bambu file (confirmed on the command line, fixture 05 in section 6). The split is lossy: every copy after the first loses its name and its colour (fixture 08).
- **`Metadata/model_settings.config`**, for reference, is XML: `<config>` with `<object id>` entries holding `<metadata key value>` (`name`, `extruder`) and `<part id subtype>` entries (normal part, modifier, negative part) with their own metadata; `<plate>` entries with `<model_instance>` items; and `<assemble>` items. Tag names from the constants in `bbs_3mf.cpp`; the full grammar was not read.
- **Other files in the package** Orca reads when present: `Metadata/project_settings.config` (the whole project configuration), `Metadata/slice_info.config`, `Metadata/plate_N.png` thumbnails, and embedded presets (`Metadata/filament_settings_N.config` and so on).

### Bambu Studio 2.8.2

[`src/libslic3r/Format/bbs_3mf.cpp`](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/libslic3r/Format/bbs_3mf.cpp) shares Orca's design and goes further (checked): each colour group keeps **all** its colours, every distinct colour gets a filament number, an object's `pid` with `pindex` picks its colour, and for files from other producers each triangle's `pid`, `p1`, `p2`, `p3` is read into per-triangle colour data. So Bambu Studio can take per-face colours from a plain 3MF; how it shows them (painted regions, or a mapping dialog) was not tried (unverified). The reader hands them to its caller as per-volume colour data rather than applying them, and the command line does not apply them (fixture 04 in section 6: no painted triangles, the face prints in the object's slot); the GUI is T3.0d's check. `pindex` on the object does pick the slot (confirmed, fixture 04). One colour group per colour with `pindex="0"` reads the same in Bambu Studio and Orca.

### PrusaSlicer 2.9.6

[`src/libslic3r/Format/3mf.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Format/3mf.cpp) has no reader for colour groups or base materials (searched for `colorgroup`, `basematerials`, `displaycolor`: none; checked). Per-volume extruders and volume types come only from its own `Metadata/Slic3r_PE_model.config`. It reads core components, nested ones included, and `p:path`, but **not as parts of one object**: a components object is an alias, and each mesh object it reaches becomes an object of its own, named after the mesh object, the components object's name dropped (`_create_object_instance`; refuted on the command line with fixtures 03 and 07, section 6). So a manufakture 3MF with colour groups loads in PrusaSlicer with correct geometry and names and no colours; the `interop` CI job already slices our 3MF with PrusaSlicer and will catch it if the extension markup ever breaks loading.

### Several bodies as one object

A multi-colour print of one design (a sign with inlaid letters, a part with a coloured label) is several bodies that belong together. In 3MF core that is one object with `<components>`, each component a mesh object. PrusaSlicer does **not** keep components as parts of one object: it makes each component its own object (refuted, see above and section 6). Orca and Bambu Studio keep one object with one part per component, but without help they name the parts after the object (`Two boxes`, `Two boxes_2`) and print every part in the object's slot, ignoring the parts' colour groups; with a `Metadata/model_settings.config` naming the parts and giving each its `extruder`, both keep the names and the slots (confirmed on the command line, fixtures 03 and 07, section 6). `packages/io`'s `parse3mf` reads components since T2.3f.

## 4. Bambu Lab build volumes

For the bed-fit check, from OrcaSlicer's printer profiles ([`resources/profiles/BBL/machine`](https://github.com/OrcaSlicer/OrcaSlicer/tree/v2.4.2/resources/profiles/BBL/machine), `* 0.4 nozzle.json`, resolved through `inherits` to `fdm_bbl_3dp_001_common.json`, `fdm_bbl_3dp_002_common.json` and `fdm_machine_common.json`; checked). Profiles are the slicer's view, which is what a part has to fit; these are facts copied as numbers with the source cited, not the profile files.

| Printer                 | Printable area (mm) | Height (mm)      | Excluded or per-nozzle areas                                                              |
| ----------------------- | ------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| A1 mini                 | 180 x 180           | 180              | none                                                                                      |
| A1                      | 256 x 256           | 256              | none                                                                                      |
| P1P, P1S, X1, X1 Carbon | 256 x 256           | 250 (inherited)  | excluded 0 to 18 by 0 to 28 at the bed origin                                             |
| X1E                     | 256 x 256           | 250 (inherited)  | same exclusion                                                                            |
| P2S                     | 256 x 256           | 256              | none                                                                                      |
| H2S                     | 340 x 320           | 340              | none                                                                                      |
| H2D, H2D Pro            | 350 x 320           | 325 (from `002`) | left nozzle 0 to 325 in x, right nozzle 25 to 350; per-nozzle heights 320 and 325 (`002`) |
| X2D                     | 256 x 256           | 261              | left nozzle full bed, right nozzle 20.5 to 256 in x; heights 261 and 256                  |

The X1 and P1 heights of 250 mm are what the profiles inherit from `fdm_machine_common.json`; Bambu Lab's marketing figure for those printers is 256 mm (unverified here). The check should use the profile value, since that is what the slicer enforces: OrcaSlicer's and Bambu Studio's command lines both apply 250 mm for the X1 Carbon (section 6). On the two-nozzle H2D and X2D a part printed with both nozzles must fit the overlap of the two areas.

The same profiles give process defaults the printability checks should start from (OrcaSlicer [`PrintConfig.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/PrintConfig.cpp) and [`fdm_process_common.json`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/resources/profiles/BBL/process/fdm_process_common.json), checked): support `support_threshold_angle` 30 degrees, measured as the **slope from horizontal** ("Support will be generated for overhangs whose slope angle is below the threshold"; 30 degrees from horizontal is 60 degrees from vertical); line width 0.42 mm for a 0.4 mm nozzle; `min_feature_size` 25% of the nozzle diameter ("Model features that are thinner than this value will not be printed"); `min_bead_width` 85%.

Elephant foot compensation matters for fits (T3.2g in the plan): `elefant_foot_compensation` (the key's own spelling) is 0 in `fdm_process_common.json`, and the BBL process profile for 0.20 mm layers, [`fdm_process_single_0.20.json`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/resources/profiles/BBL/process/fdm_process_single_0.20.json), overrides it with 0.15 mm (read at the v2.4.2 tag during review of the M3 plan). So a part sliced with the default 0.20 mm profile has its first layer compensated by 0.15 mm, which changes how a hole or peg fits near the bed.

## 5. Recommendation

1. **M3 hands off by download.** "Open in slicer" exports a slicer-ready 3MF (section 3) with a clear file name and downloads it, then shows a short, dismissible panel for the chosen slicer: how to open it from the browser's download list, how to make the slicer the default for `.3mf` (Orca's `associate_3mf` on Windows), and Chrome's "always open" choice if the spike confirms it for `.3mf`. The chosen slicer is remembered with the view settings. This works everywhere, needs no server and uploads nothing.
2. **No custom-scheme launch in M3.** There is no URL we could give the slicer (section 2), so a button that navigates to `orcaslicer://` would at best open an empty slicer. It is not built.
3. **Write standard 3MF that Orca and Bambu Studio map to filaments.** Keep the core package and add: the materials namespace with the prefix `m`; one `m:colorgroup` per distinct body colour with a single `m:color`; `pid` and `pindex="0"` on each object; build items with transforms for print orientation and placement on the bed. No `requiredextensions` for the colours, so a consumer that ignores them still loads the geometry. Do not write `Application` values that impersonate Bambu Studio or OrcaSlicer. The production extension is not needed.
4. **Decide the rest by evidence.** Whether several bodies go out as one component object, and whether a `Metadata/model_settings.config` (per-object extruder, plates) helps third-party files, is decided by the spike's load matrix in OrcaSlicer 2.4.2, Bambu Studio 2.8.2 and PrusaSlicer 2.9.6. Where OrcaSlicer's command line can load a file and write it back as a project 3MF (`--export-3mf`, `--slice`, defined in `PrintConfig.cpp`, checked), the resulting `model_settings.config` is a machine-readable record of what Orca made of our file; that is the basis for an optional CI check next to the existing `interop` job. The command-line results and a provisional call are in section 6.
5. **For M7, an optional hosted hand-off.** Once a server exists: upload the 3MF only after the user asks, to a short-lived unguessable https URL whose path ends in `.3mf`, then navigate to `orcaslicer://open?file=<url-encoded URL>` (no prompt in Orca) or `bambustudio://open?file=` (one trust prompt), always with the download offered next to it. PrusaSlicer would need our domain allowlisted by Prusa; self-hosted instances never would be, so it keeps the download path.

## 6. Verified

Command-line checks from the M3 spike (T3.0a), run on 2026-10-01. The GUI and browser checks are T3.0d's; their empty tables and the checklist are at the end of this section.

### Setup

| Program      | Version reported          | Build used                                                                                                                                          |
| ------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| OrcaSlicer   | `OrcaSlicer-2.4.2`        | upstream `OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage`, SHA-256 `d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd`         |
| Bambu Studio | `BambuStudio-02.08.02.61` | upstream `BambuStudio_ubuntu24.04-v02.08.02.61-20260820225108.AppImage`, SHA-256 `d501b103fac5424513ec0e8d6bc145fb30719de2c7d94d7320d723740c81a7fd` |
| PrusaSlicer  | `PrusaSlicer-2.9.6+arch5` | Arch Linux package `prusa-slicer` 2.9.6-5 (upstream publishes no Linux build of 2.9.6 on GitHub; Flathub only)                                      |

- **Operating system.** Arch Linux, x86_64, kernel 7.2.7, in a container with no display server, no GPU and no system-wide install of any slicer: the AppImages were unpacked with `--appimage-extract` (no FUSE), and the shared libraries they expect from the host were unpacked from Arch packages into a directory on `LD_LIBRARY_PATH`. Node 26.10.
- **Printer.** Bambu Lab X1 Carbon, 0.4 mm nozzle, profile `Bambu Lab X1 Carbon 0.4 nozzle`, process `0.20mm Standard @BBL X1C`, two filament slots of `Bambu PLA Basic @BBL X1C` coloured `#FF0000` and `#0000FF` (as an AMS would hold them). The profiles were read from each install at run time; none is in this repository.
- **Bambu Studio** was not in the plan for this task; its command line takes the same flags and profiles as OrcaSlicer's, so the same script ran it at no extra cost, and it answers some of T3.0d's questions early. PrusaSlicer ran with its built-in defaults (one extruder), as in the `interop` CI job.

### The fixtures

Committed in `packages/io/src/fixtures/slicers/` and built by `packages/io/scripts/slicer-fixtures.ts` (`pnpm --filter @manufakture/io fixtures:slicers`); `fixtures.test.ts` next to them checks that the files are what the script builds, that each is a valid core 3MF, and that 01 is what `write3mf` writes. Every fixture is a red box (20 x 20 x 10 mm) and a blue box (30 x 15 x 8 mm) side by side near the middle of a 256 mm bed; every one says `Application` `manufakture`.

| Fixture                            | Holds                                                                                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01-core.3mf`                      | what `write3mf` writes today: two mesh objects, two build items, no colours                                                                                       |
| `02-colorgroups.3mf`               | decision 12 of the plan: one `m:colorgroup` per colour holding one `m:color`, `pid` and `pindex="0"` on each object                                               |
| `03-components.3mf`                | 02's two coloured mesh objects, and one object "Two boxes" made of both as components; one build item                                                             |
| `04-pindex-triangles.3mf`          | one colour group holding both colours: the red box `pindex="0"`, the blue box `pindex="1"`, and the red box's top face (two triangles) blue by `pid` and `p1`     |
| `05-model-settings.3mf`            | 01 (no colour groups) plus a minimal `Metadata/model_settings.config`: per object, `name` and `extruder` 1 or 2                                                   |
| `06-transforms.3mf`                | 02 with both boxes modelled at the origin; the red box's build item turns it 90 degrees about x (it then stands 20 mm tall) and moves it, the blue one's moves it |
| `07-components-model-settings.3mf` | 03 plus a `model_settings.config` naming the components object and giving each part (by component object id) its `name` and `extruder`                            |
| `08-instances.3mf`                 | not in the plan's list: 02's two objects at the origin, the blue box placed twice by two build items, as an assembly export (T2.3f) writes a part placed twice    |

### How the matrix was run

`packages/io/scripts/orca-matrix.ts` (`pnpm --filter @manufakture/io orca:matrix`; `ORCA_CMD`, `ORCA_PROFILES` and `ORCA_OUT` select the program, its profiles and the output directory) runs every fixture twice and reads back what the slicer wrote:

- **load**: `--arrange 0 --export-3mf project.3mf <fixture>`, no profiles: what the slicer makes of the file;
- **slice**: the same plus `--slice 0 --load-settings "<printer>;<process>" --load-filaments "<slot 1>;<slot 2>"` for the X1 Carbon.

From each project 3MF it reads `Metadata/model_settings.config` (objects, parts, names, `extruder` per object and part), the placed meshes (each object's world bounding box through its component and build-item transforms), `slice_info.config` (filament slots the plate uses), `project_settings.config` (slot colours) and the G-code (which slot each object is printed with: the `M620 S<n>A` slot selection before each object block). PrusaSlicer ran by hand: `prusa-slicer --export-gcode` and `--export-3mf` per fixture, reading objects and volumes from `Metadata/Slic3r_PE_model.config` and the top layer from the G-code.

### Command-line matrix

Positions are world bounding boxes in mm, min to max. The load and slice runs agreed on every object, name, slot and position, so one row covers both; "slices" means exit status 0, `return_code` 0 and a G-code file.

| Fixture | OrcaSlicer 2.4.2                                                                                                                                                                                                      | Bambu Studio 2.8.2                                                                      | PrusaSlicer 2.9.6                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 01      | 2 objects "Red box", "Blue box", one part each named after it; both slot 1; positions as written (90,120,0 to 110,140,10 and 130,122.5,0 to 160,137.5,8); slices with 1 filament                                      | same as Orca                                                                            | 2 objects, named; slices                                                 |
| 02      | 2 objects, named; red slot 1, blue slot 2; positions as written; slices with both filaments, the G-code printing red in slot 1 and blue in slot 2                                                                     | same as Orca                                                                            | 2 objects, named, no colours (one extruder); slices                      |
| 03      | 1 object "Two boxes", parts named "Two boxes" and "Two boxes_2" (the mesh names are lost); the object in slot 1 and no slot on the parts, so both boxes print in slot 1; positions as written; slices with 1 filament | same as Orca                                                                            | 2 objects "Red box", "Blue box"; the name "Two boxes" is dropped; slices |
| 04      | 2 objects, named; **both slot 1** (`pindex` ignored: one group gives one slot); top face not painted; slices with 1 filament                                                                                          | red slot 1, **blue slot 2** (`pindex` honoured); top face not painted, prints in slot 1 | 2 objects, named; slices                                                 |
| 05      | 2 objects, named; red slot 1, blue slot 2 from `model_settings.config`; slices with both filaments                                                                                                                    | same as Orca                                                                            | 2 objects, named; `model_settings.config` ignored; slices                |
| 06      | red box 90,125,0 to 110,135,20: turned onto its side and moved as the item says; blue as written; slots 1 and 2; slices with both filaments                                                                           | same as Orca                                                                            | 2 objects; slices, top layer at 19.85 mm (the red box stands 20 mm tall) |
| 07      | 1 object "Two boxes", parts **"Red box" slot 1 and "Blue box" slot 2**; positions as written; slices, the one object printed with both filaments                                                                      | same as Orca (both filaments used)                                                      | 2 objects "Red box", "Blue box", no colours; slices                      |
| 08      | 3 objects: "Red box" slot 1, "Blue box" slot 2 at y 122.5, and a copy at y 150 with an **empty name and slot 1**: the object is split per build item, and the copy loses its name and its colour; slices              | same as Orca                                                                            | 3 objects "Red box", "Blue box", "Blue box", named; slices               |

Across every fixture:

- **Slot colours never come from the file.** After a load, the project holds one filament in the slicer's default colour (`#F2754E` in Orca, `#00AE42` in Bambu Studio), whatever colours the file declares; in the slice runs the slots are the colours the command line gave. The file's colours only decide slot numbers.
- **Nothing was repaired or rejected**: no run logged a warning about the model, and every mesh came back with `mesh_stat` all zero (no edges fixed, no facets removed or reversed).
- **Third-party files stay third-party.** No fixture was taken for a Bambu project, including 05 and 07 with their `model_settings.config` (no "valid model config" error, no project settings loaded).
- Both CLIs resolved the X1 Carbon profile to a printable area of 256 x 256 mm, height 250 mm, excluded area 0 to 18 by 0 to 28 mm, `support_threshold_angle` 30, `line_width` 0.42, `min_feature_size` 25% and `elefant_foot_compensation` 0.15 for `0.20mm Standard @BBL X1C`, which confirms section 4's X1 Carbon row and process defaults as the slicers apply them.

### Claims settled

| Claim (section)                                                                                     | Result                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Orca turns object-level colour groups (prefix `m`) into filament slots (3)                          | **confirmed** (02, 06); other prefixes not tried                                                                                |
| Orca ignores `pindex` and per-triangle `pid`, `p1` to `p3` (3)                                      | **confirmed** (04: both objects slot 1, no painted triangles)                                                                   |
| Orca takes no filament colours from the file (3, was unverified)                                    | **confirmed** on the command line, Bambu Studio too; the GUI is T3.0d's                                                         |
| Orca applies `model_settings.config` per-object `extruder` for a non-Bambu file (3, was unverified) | **confirmed** (05); per-part `name` and `extruder` too (07)                                                                     |
| Orca splits an object with several build items into one object per item (3)                         | **confirmed** (08), and found lossy: copies after the first lose their name and colour                                          |
| How Orca and Bambu Studio map a component object's parts and colours (3, was unverified)            | **settled** (03, 07): one object, parts named after the object, part colours ignored, unless `model_settings.config` names them |
| Bambu Studio: `pid` with `pindex` picks the slot (3)                                                | **confirmed** (04)                                                                                                              |
| Bambu Studio takes per-face colours from a plain 3MF (3, display unverified)                        | **not on the command line** (04: no painted triangles); the reader passes them to the GUI, so T3.0d checks there                |
| PrusaSlicer reads no colour groups (3)                                                              | **confirmed** (no extruder in what it writes back)                                                                              |
| PrusaSlicer reads components as parts of one object (3)                                             | **refuted** (03, 07): each component becomes an object of its own; the source agrees (`_create_object_instance`)                |
| OrcaSlicer's `--export-3mf` and `--slice` can record what Orca made of a file (5)                   | **confirmed**: headless, under a second per run                                                                                 |
| X1 Carbon build volume and process defaults from the profiles (4)                                   | **confirmed** as both CLIs apply them                                                                                           |

Not settled here, since a command line cannot show them: everything in sections 1 and 2 (URL schemes, `file://` through Orca's downloader, browser behaviour, Bambu Studio's Windows scheme registration), Chrome's "always open" for `.3mf`, Orca's `.3mf` association on Windows, and how the GUIs show what the CLIs loaded. Those are T3.0d's, below. Bambu Lab's marketing height of 256 mm for the X1 (section 4) stays unverified and does not matter: the slicers enforce 250.

### What the command line needs, for T3.3c

- **No display.** Neither CLI needs X11, Wayland or xvfb to load, slice and export. Without OpenGL they skip plate thumbnails and say so: Orca in a stray `00000.log` in the working directory ("glfwInit return error ... OpenGL context unavailable; skip thumbnail generating"), Bambu Studio in its log output ("Wayland: Failed to connect to display"). PrusaSlicer 2.9.6's `--export-gcode` did not need a display either; the `interop` job's `xvfb-run` is harmless.
- **The GUI's libraries all the same.** The binaries link GTK 3, WebKitGTK 4.1, libsoup 3, GStreamer, Mesa (GL, EGL, GLX, GLU, OpenGL), X11 (with SM, ICE, Xext), xkbcommon, Wayland, Pango, HarfBuzz, ATK, Cairo, gdk-pixbuf, fontconfig and libmspack (31 libraries missing on a bare system for Orca), so a CI image needs them installed even though no window opens. Bambu Studio's `AppRun` overwrites `LD_LIBRARY_PATH` with its own `bin/`, so run its binary directly with both on the path.
- **A locale.** Run with `LC_ALL=C` where no locale is generated (the AppImages' `AppRun` does this; calling the binaries directly aborts with `locale::facet::_S_create_c_locale name not valid`, PrusaSlicer stops with "An error occured while setting up locale").
- **No first-run setup.** No profile wizard, data directory or login; a writable `HOME` is enough. Orca and Bambu Studio write `result.json` (status, `return_code`, error text) into the output directory, and into the working directory even for `--help`. A failed slice exits non-zero (156 here) with `return_code` -100.
- **Flattened profiles.** `--load-settings` and `--load-filaments` do **not** resolve a system profile's `inherits` chain: given `Bambu Lab X1 Carbon 0.4 nozzle.json` the CLI applies only that file's keys and leaves the rest at built-in defaults (a 200 x 200 x 100 mm bed, one filament colour). The script merges each profile with its parents first.
- **One `filament_colour` per filament.** Two filaments loaded without a colour each leave the project with one filament colour, and slicing a two-colour model then fails with "Grouping error: PLA can not be placed in the right nozzle" (the filament map is sized by the colour list). Setting `filament_colour` in each flattened filament profile fixes it. `--filament-colour "#FF0000;#0000FF"` on the command line crashed Orca 2.4.2 (segmentation fault, exit 139).
- **`--arrange 0`.** By default the CLI arranges the plate, moving every object; positions are only comparable with arranging off.

### Provisional recommendation for T3.3a

From the matrix (Orca and Bambu Studio agree everywhere except `pindex`, where Orca is the weaker):

1. **Write one mesh object per placed body**, with the colour groups of decision 12 and build-item transforms (fixtures 02 and 06). Names, slots and positions arrive intact in Orca and Bambu Studio, PrusaSlicer loads the geometry and names, and nothing Bambu-specific is written. Where an assembly places a part several times, write each placement as its own object (the mesh repeated) rather than one object with several build items: 08 shows Orca and Bambu Studio splitting such an object and dropping the name and colour of every copy after the first.
2. **No components without `model_settings.config`.** A bare components object (03) is worse than separate objects in every slicer: Orca and Bambu Studio lose the body names and print every body in one slot, and PrusaSlicer splits it anyway and drops its name. T2.3f's `export3mfAssembly` writes the structure of 03 (without colour groups) for a part of several bodies and the structure of 08 for a part placed twice, so T3.3a should change both.
3. **Components with a minimal `model_settings.config` only for a part of several bodies that must stay one object** (a sign with inlaid letters, bodies that touch): 07 is the only shape that keeps one object with named parts and a slot per part in Orca and Bambu Studio. Write only `<object id>` with `name` and `extruder`, and `<part id="<component object id>" subtype="normal_part">` with `name` and `extruder`: no plates, no matrices, no `Application` claim, no project settings. PrusaSlicer then shows separate named objects, which is what it shows for 02 too. If T3.0d finds the GUIs treat 07 differently from their CLIs, T3.3a falls back to item 1 for such parts.
4. **`model_settings.config` is not needed for separate objects**: 05 gives the same slots as 02 in both slicers, so colour groups alone carry the slot.
5. **No `pindex` other than 0 and no per-triangle colours**: Orca ignores both (04), and per-face colour is not on M3's list.

### GUI matrix (T3.0d)

To be filled by T3.0d, one table per slicer, on at least one operating system. Write `same as CLI` where the GUI matches the command-line row above, and the difference otherwise.

**OrcaSlicer 2.4.2** (operating system: ...; date: ...)

| Fixture | Dialogs and warnings, verbatim | Object list: objects, parts, names | Slot per object and part | Position on the plate | Slot colours after load | Slices? Filaments in the preview | Differs from CLI? |
| ------- | ------------------------------ | ---------------------------------- | ------------------------ | --------------------- | ----------------------- | -------------------------------- | ----------------- |
| 01      |                                |                                    |                          |                       |                         |                                  |                   |
| 02      |                                |                                    |                          |                       |                         |                                  |                   |
| 03      |                                |                                    |                          |                       |                         |                                  |                   |
| 04      |                                |                                    |                          |                       |                         |                                  |                   |
| 05      |                                |                                    |                          |                       |                         |                                  |                   |
| 06      |                                |                                    |                          |                       |                         |                                  |                   |
| 07      |                                |                                    |                          |                       |                         |                                  |                   |
| 08      |                                |                                    |                          |                       |                         |                                  |                   |

**Bambu Studio 2.8.2** (operating system: ...; date: ...)

| Fixture | Dialogs and warnings, verbatim | Object list: objects, parts, names | Slot per object and part | Position on the plate | Slot colours after load | Slices? Filaments in the preview | Differs from CLI? |
| ------- | ------------------------------ | ---------------------------------- | ------------------------ | --------------------- | ----------------------- | -------------------------------- | ----------------- |
| 01      |                                |                                    |                          |                       |                         |                                  |                   |
| 02      |                                |                                    |                          |                       |                         |                                  |                   |
| 03      |                                |                                    |                          |                       |                         |                                  |                   |
| 04      |                                |                                    |                          |                       |                         |                                  |                   |
| 05      |                                |                                    |                          |                       |                         |                                  |                   |
| 06      |                                |                                    |                          |                       |                         |                                  |                   |
| 07      |                                |                                    |                          |                       |                         |                                  |                   |
| 08      |                                |                                    |                          |                       |                         |                                  |                   |

**PrusaSlicer 2.9.6** (operating system: ...; date: ...)

| Fixture | Dialogs and warnings, verbatim | Object list: objects, parts, names | Extruder per object and part | Position on the plate | Slices? | Differs from CLI? |
| ------- | ------------------------------ | ---------------------------------- | ---------------------------- | --------------------- | ------- | ----------------- |
| 01      |                                |                                    |                              |                       |         |                   |
| 02      |                                |                                    |                              |                       |         |                   |
| 03      |                                |                                    |                              |                       |         |                   |
| 04      |                                |                                    |                              |                       |         |                   |
| 05      |                                |                                    |                              |                       |         |                   |
| 06      |                                |                                    |                              |                       |         |                   |
| 07      |                                |                                    |                              |                       |         |                   |
| 08      |                                |                                    |                              |                       |         |                   |

**Hand-off** (operating system, browser versions: ...; date: ...)

| Check                                                                       | Chrome | Firefox | Notes |
| --------------------------------------------------------------------------- | ------ | ------- | ----- |
| `.3mf` download: is "Always open files of this type" (or similar) offered?  |        |         |       |
| After choosing it, does the next `.3mf` download open in the slicer?        |        |         |       |
| Any download warning (Safe Browsing or similar), verbatim                   |        |         |       |
| `orcaslicer://open?file=<https URL>`: browser prompt, verbatim              |        |         |       |
| ... does Orca open and load the file? Download folder needed?               |        |         |       |
| `orcaslicer://open?file=<file:// URL>`: does Orca load a local file?        |        |         |       |
| `bambustudio://open?file=<https URL>`: trust prompt, verbatim, and result   |        |         |       |
| `prusaslicer://open?file=<https URL>`: notification, verbatim               |        |         |       |
| Unregistered scheme (`notaslicer://open`): what the user sees               |        |         |       |
| Windows: OrcaSlicer's "associate .3mf" preference, then double-click a file |        |         |       |

### Checklist for T3.0d

Before starting:

1. Install OrcaSlicer 2.4.2, Bambu Studio 2.8.2 (02.08.02.61) and PrusaSlicer 2.9.6 from their GitHub releases (PrusaSlicer on Linux from Flathub), plus current Chrome and Firefox. Note the operating system and every version in the table headings above.
2. Get the eight fixtures from `packages/io/src/fixtures/slicers/` at the commit that added this section (or rebuild them: `pnpm --filter @manufakture/io fixtures:slicers`; the test fails if they differ).
3. In OrcaSlicer and Bambu Studio, select the printer **Bambu Lab X1 Carbon, 0.4 mm nozzle**, with four filament slots set to colours that are **neither red nor blue** (for example white, black, grey, yellow), so a colour taken from the file stands out. In PrusaSlicer, use any single-extruder printer profile; if a multi-material profile is at hand, note it.

For each slicer, for each fixture 01 to 08, starting from a new empty project each time:

4. Open the fixture with File, Import (in Orca and Bambu Studio, "Import 3MF/STL/STEP..."; if asked whether to open it as a project or import geometry, choose the default and write the question down verbatim). Also try one fixture by drag and drop and note any difference.
5. Copy every dialog, warning or repair prompt word for word into "Dialogs and warnings".
6. In the object list, write down every object and its parts (expand them) with their names exactly as shown, including empty names.
7. Write down the filament slot (or extruder) shown for each object and each part.
8. Select each object and read its position (Object manipulation: X, Y, Z) or describe where it sits; note whether the slicer centred or arranged the objects instead of keeping the file's positions (01 to 05, 07: side by side near the bed centre; 06: the red box standing 20 mm tall; 08: two blue boxes one behind the other).
9. Write down the colours of the filament slots after loading: unchanged, or changed (to what), or slots added.
10. For 04 in Bambu Studio and Orca: is the red box's top face shown blue (painted), or does a colour mapping dialog appear?
11. Slice the plate. Note success or the error verbatim, and the filaments listed in the preview's legend.
12. Compare with the command-line matrix row and fill in "Differs from CLI?".

Hand-off, in Chrome and in Firefox:

13. Download a `.3mf` (a fixture from the repository's file view with "Download raw file", or an export from the app). In the browser's download bubble or list, look for "Always open files of this type" (Chrome) or "Always open similar files" (Firefox); note whether it is offered, choose it, download again and note what opens.
14. Put `02-colorgroups.3mf` on a public static https host (any static hosting that serves the file with a URL ending in `.3mf`). Make a local HTML page with three links: `orcaslicer://open?file=<URL-encoded https URL>`, `bambustudio://open?file=<same>` and `prusaslicer://open?file=<same>`, and click each. Note each browser prompt and each slicer's response word for word (Orca: does it ask for a download folder? Bambu Studio: the trust prompt; PrusaSlicer: the refusal notification), and whether the loaded model matches the GUI import above.
15. Repeat Orca's link with a `file://` URL of a local copy (`orcaslicer://open?file=file%3A%2F%2F%2F<absolute path>`) and note whether Orca loads it.
16. Click a link with a scheme no program registered (`notaslicer://open`) and note what each browser shows, if anything.
17. On Windows: in OrcaSlicer's preferences, turn on associating `.3mf` files with OrcaSlicer, then double-click a fixture in Explorer and note what opens.

Where the results go: fill the four tables above, mark each remaining "unverified" in sections 1 to 3 that a check settled as confirmed or refuted, and confirm or revise the provisional recommendation above with the evidence. If the revision changes what T3.3a writes and T3.3a has already landed, file the change as a follow-up task to T3.3a.

## Sources

- OrcaSlicer 2.4.2: [`GUI_App.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/GUI_App.cpp), [`Downloader.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/Downloader.cpp), [`DownloaderFileGet.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/GUI/DownloaderFileGet.cpp), [`Http.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/slic3r/Utils/Http.cpp), [`CURL.cmake`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/deps/CURL/CURL.cmake), [`bbs_3mf.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/Format/bbs_3mf.cpp), [`PrintConfig.cpp`](https://github.com/OrcaSlicer/OrcaSlicer/blob/v2.4.2/src/libslic3r/PrintConfig.cpp), [BBL machine profiles](https://github.com/OrcaSlicer/OrcaSlicer/tree/v2.4.2/resources/profiles/BBL/machine), [BBL process profiles](https://github.com/OrcaSlicer/OrcaSlicer/tree/v2.4.2/resources/profiles/BBL/process), [PR #8377](https://github.com/OrcaSlicer/OrcaSlicer/pull/8377)
- Bambu Studio 2.8.2: [`GUI_App.cpp`](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/slic3r/GUI/GUI_App.cpp), [`bbs_3mf.cpp`](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/libslic3r/Format/bbs_3mf.cpp), [`BambuStudio.desktop`](https://github.com/bambulab/BambuStudio/blob/v02.08.02.61/src/platform/unix/BambuStudio.desktop), [issue #6120](https://github.com/bambulab/BambuStudio/issues/6120)
- PrusaSlicer 2.9.6: [`Downloader.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/slic3r/GUI/Downloader.cpp), [`GUI_App.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/slic3r/GUI/GUI_App.cpp), [`3mf.cpp`](https://github.com/prusa3d/PrusaSlicer/blob/version_2.9.6/src/libslic3r/Format/3mf.cpp), [issue #13752](https://github.com/prusa3d/PrusaSlicer/issues/13752), [issue #14313](https://github.com/prusa3d/PrusaSlicer/issues/14313), [Prusa knowledge base: opening models from supported websites](https://help.prusa3d.com/article/opening-models-in-prusaslicer-from-supported-websites_399198)
- [Bambu Lab wiki: third-party integration (Bambu Connect)](https://wiki.bambulab.com/en/software/third-party-integration)
- [W3C File API](https://w3c.github.io/FileAPI/), sections 8.2 to 8.3.3
- [3MF Materials and Properties Extension 1.2.1](https://github.com/3MFConsortium/spec_materials/blob/master/3MF%20Materials%20Extension.md), [3MF Production Extension 1.2](https://github.com/3MFConsortium/spec_production/blob/master/3MF%20Production%20Extension.md)
- [Chrome Enterprise policy `AutoOpenFileTypes`](https://chromeenterprise.google/policies/auto-open-file-types/)
