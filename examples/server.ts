import { Server } from "r2-streamer-js";
import * as express from "express";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

import recursive from "recursive-readdir";

interface PublicationEntry {
  title: string;
  filename: string;
  type: "epub" | "pdf" | "audiobook";
  hosted?: boolean;
  viewers: { title: string; url: string }[];
}

async function start() {
  const publications: PublicationEntry[] = [];

  const server = new Server({
    disableDecryption: true,
    disableOPDS: true,
    disableReaders: true,
    disableRemotePubUrl: true,
    maxPrefetchLinks: 5,
  });

  // ── Serve viewer files ──────────────────────────────────────────────

  server.expressUse(
    "/viewer",
    //@ts-ignore
    express.static(path.join(__dirname, "../viewer"), { fallthrough: true })
  );
  //@ts-ignore
  server.expressUse("/viewer", express.static(path.join(__dirname, "../dist")));

  // Serve node_modules so viewer HTML files can reference @readium/css
  // directly without a build step.
  //@ts-ignore
  server.expressUse(
    "/node_modules",
    //@ts-ignore
    express.static(path.join(__dirname, "../node_modules"))
  );

  // ── Landing page ────────────────────────────────────────────────────

  // ── PDF serving ─────────────────────────────────────────────────────

  // Serve PDFs as static files
  const pdfsPath = path.join(__dirname, "./epubs"); // PDFs live alongside EPUBs
  //@ts-ignore
  server.expressUse("/pdfs", express.static(pdfsPath));

  // Generate a simple RWPM manifest for a PDF file
  // Use path-based URL (/pdf-manifest/filename.pdf) to avoid query string conflicts
  server.expressUse("/pdf-manifest", (req: any, res: any, next: any) => {
    // Extract filename from path: /pdf-manifest/daisy.pdf → daisy.pdf
    const file = decodeURIComponent(req.path.replace(/^\//, ""));
    if (!file) {
      next();
      return;
    }

    const filename = path.basename(file);
    const title = filename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");

    const pdfHref = `/pdfs/${file}`;
    const manifestHref = `/pdf-manifest/${encodeURIComponent(file)}`;

    const manifest = {
      "@context": "https://readium.org/webpub-manifest/context.jsonld",
      metadata: {
        "@type": "https://schema.org/Book",
        conformsTo: "https://readium.org/webpub-manifest/profiles/pdf",
        title: title,
        identifier: `urn:pdf:${filename}`,
      },
      links: [
        { rel: "self", href: manifestHref, type: "application/webpub+json" },
        { rel: "alternate", href: pdfHref, type: "application/pdf" },
      ],
      readingOrder: [
        {
          href: pdfHref,
          type: "application/pdf",
          title: title,
        },
      ],
      resources: [{ href: pdfHref, type: "application/pdf" }],
    };

    res.json(manifest);
  });

  // ── Publications API ────────────────────────────────────────────────

  server.expressUse("/api/publications", (req: any, res: any) => {
    res.json(publications);
  });

  server.expressUse("/books", (req: any, res: any) => {
    const slug = decodeURIComponent(req.path.replace(/^\//, ""));
    const publication = publications.find(
      (entry) =>
        entry.type === "epub" &&
        entry.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "") === slug
    );
    const viewer = publication?.viewers.find(
      (entry) => entry.title === "DITA Toolkit (ReadiumCSS v2)"
    );
    if (!viewer) {
      res.status(404).send("Book unavailable");
      return;
    }
    res.redirect(302, viewer.url);
  });

  // ── Scan local files ────────────────────────────────────────────────

  const epubsPath = path.join(__dirname, "./epubs");

  // Scan EPUBs
  recursive(epubsPath, ["!*.epub"], function (err, files) {
    if (err) {
      console.error("Error scanning EPUBs:", err);
      return;
    }

    const filePaths = files.map((fileName) => path.join(fileName));
    const publicationURLs = server.addPublications(filePaths);
    console.log(`📚 Found ${publicationURLs.length} EPUB(s)`);

    // Add EPUBs to our publications list
    filePaths.forEach((filePath, i) => {
      const filename = path.basename(filePath);
      const title = filename.replace(/\.epub$/i, "").replace(/[_-]/g, " ");
      const manifestUrl = publicationURLs[i];

      publications.push({
        title,
        filename,
        type: "epub",
        viewers: [
          {
            title: "DITA Toolkit (ReadiumCSS v1)",
            url: `/viewer/index_dita.html?url=${manifestUrl}`,
          },
          {
            title: "DITA Toolkit (ReadiumCSS v2)",
            url: `/viewer/index_dita_v2.html?url=${manifestUrl}`,
          },
          {
            title: "Minimal",
            url: `/viewer/index_minimal.html?url=${manifestUrl}`,
          },
          {
            title: "API Test",
            url: `/viewer/index_api.html?url=${manifestUrl}`,
          },
          {
            title: "Sample Read",
            url: `/viewer/index_sampleread.html?url=${manifestUrl}`,
          },
          {
            title: "Injectables",
            url: `/viewer/index_injectables.html?url=${manifestUrl}`,
          },
          {
            title: "Small Window (600×500)",
            url: `/viewer/index_small_window.html?url=${manifestUrl}`,
          },
        ],
      });
    });
  });

  // ── Local audiobooks ────────────────────────────────────────────────
  //
  // The Readium Audiobook Profile distribution format is the W3C
  // Lightweight Packaging Format (LPF) — a ZIP file containing a
  // manifest.json and the audio resources, conventionally with the
  // `.audiobook` extension. Drop one in examples/epubs/ alongside
  // .epub and .pdf files; the server unpacks it on startup so the
  // viewer can fetch the manifest and audio over plain HTTP.

  const audiobookCachePath = path.join(__dirname, "./.audiobook-cache");
  if (!fs.existsSync(audiobookCachePath)) {
    fs.mkdirSync(audiobookCachePath, { recursive: true });
  }
  //@ts-ignore
  server.expressUse("/audiobook-cache", express.static(audiobookCachePath));

  recursive(epubsPath, ["!*.audiobook"], function (err, files) {
    if (err) {
      console.error("Error scanning audiobooks:", err);
      return;
    }
    console.log(`🎧 Found ${files.length} audiobook(s)`);
    files.forEach((filePath) => {
      const filename = path.basename(filePath);
      const basename = filename.replace(/\.audiobook$/i, "");
      const title = basename.replace(/[_-]/g, " ");
      const cacheDir = path.join(audiobookCachePath, basename);

      // Re-extract if the cache is missing or older than the source.
      const cacheStale =
        !fs.existsSync(cacheDir) ||
        !fs.existsSync(path.join(cacheDir, "manifest.json")) ||
        fs.statSync(filePath).mtimeMs > fs.statSync(cacheDir).mtimeMs;

      if (cacheStale) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        fs.mkdirSync(cacheDir, { recursive: true });
        try {
          execSync(`unzip -q -o "${filePath}" -d "${cacheDir}"`);
        } catch (extractError) {
          console.error(`Failed to extract ${filename}:`, extractError);
          return;
        }
      }

      publications.push({
        title,
        filename,
        type: "audiobook",
        viewers: [
          {
            title: "Audiobook Reader",
            url: `/viewer/index_audiobook.html?url=/audiobook-cache/${basename}/manifest.json`,
          },
          {
            title: "Minimal Player",
            url: `/viewer/index_audiobook_minimal.html?url=/audiobook-cache/${basename}/manifest.json`,
          },
        ],
      });
    });
  });

  // Scan PDFs
  recursive(epubsPath, ["!*.pdf"], function (err, files) {
    if (err) {
      console.error("Error scanning PDFs:", err);
      return;
    }

    console.log(`📄 Found ${files.length} PDF(s)`);

    files.forEach((filePath) => {
      const relativePath = path
        .relative(epubsPath, filePath)
        .replace(/\\/g, "/");
      const filename = path.basename(filePath);
      const title = filename.replace(/\.pdf$/i, "").replace(/[_-]/g, " ");
      publications.push({
        title,
        filename,
        type: "pdf",
        viewers: [
          {
            title: "PDF Viewer",
            url: `/viewer/index_pdf.html?url=/pdf-manifest/${encodeURIComponent(relativePath)}`,
          },
        ],
      });
    });
  });

  // ── Start server ────────────────────────────────────────────────────

  const data = await server.start(4444, false);

  console.log(
    `\n🚀 DITA Toolkit Library: http://localhost:${data.urlPort}/viewer/index.html\n`
  );
}

(async () => {
  await start();
})();
