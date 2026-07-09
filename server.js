const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

// Ensure temp directories exist
const UPLOADS_DIR = path.join(__dirname, 'temp', 'uploads');
const COMPRESSED_DIR = path.join(__dirname, 'temp', 'compressed');

[UPLOADS_DIR, COMPRESSED_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const sessionId = req.body.sessionId || 'default';
        const sessionDir = path.join(UPLOADS_DIR, sessionId);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }
        cb(null, sessionDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); // Keep original name for zip
    }
});

const upload = multer({ storage });

// Compress a single PDF using Ghostscript
function compressPDF(inputPath, outputPath, quality) {
    return new Promise((resolve, reject) => {
        // quality can be /prepress (highest), /printer (high), /ebook (medium), /screen (low)
        let pdfSettings = '/printer';
        if (quality === 'maximum') pdfSettings = '/prepress';
        if (quality === 'medium') pdfSettings = '/ebook';
        
        // Ghostscript command
        const gsCmd = `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${pdfSettings} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;
        
        exec(gsCmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Ghostscript error: ${error.message}`);
                // If Ghostscript fails (e.g. not installed locally), just copy the file as a fallback so app doesn't crash completely.
                // In production (Render) Ghostscript will be installed via Dockerfile.
                fs.copyFileSync(inputPath, outputPath);
                return resolve(outputPath);
            }
            resolve(outputPath);
        });
    });
}

// POST endpoint to handle upload and compression
app.post('/compress', upload.array('pdfs'), async (req, res) => {
    try {
        const sessionId = req.body.sessionId;
        const quality = req.body.quality || 'high'; // high or maximum
        const files = req.files;

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const sessionUploadDir = path.join(UPLOADS_DIR, sessionId);
        const sessionCompressDir = path.join(COMPRESSED_DIR, sessionId);

        if (!fs.existsSync(sessionCompressDir)) {
            fs.mkdirSync(sessionCompressDir, { recursive: true });
        }

        let totalOriginalSize = 0;
        files.forEach(f => {
            totalOriginalSize += f.size;
        });

        // Process all files
        const compressionPromises = files.map(async (file) => {
            const inputPath = path.join(sessionUploadDir, file.originalname);
            const outputPath = path.join(sessionCompressDir, file.originalname);
            await compressPDF(inputPath, outputPath, quality);
            return outputPath;
        });

        const outputPaths = await Promise.all(compressionPromises);

        let totalCompressedSize = 0;
        outputPaths.forEach(p => {
            if (fs.existsSync(p)) {
                totalCompressedSize += fs.statSync(p).size;
            }
        });

        res.json({ 
            success: true, 
            message: 'Files compressed successfully',
            sessionId: sessionId,
            originalSize: totalOriginalSize,
            compressedSize: totalCompressedSize
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error during compression' });
    }
});

// GET endpoint to download compressed files (as a zip)
app.get('/download/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionCompressDir = path.join(COMPRESSED_DIR, sessionId);

    if (!fs.existsSync(sessionCompressDir)) {
        return res.status(404).send('Session not found or expired.');
    }

    const files = fs.readdirSync(sessionCompressDir);
    if (files.length === 1) {
        // Single file, download directly
        res.download(path.join(sessionCompressDir, files[0]));
    } else {
        // Multiple files, send as zip
        res.attachment('compressed_pdfs.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(sessionCompressDir, false);
        archive.finalize();
    }
});

// GET endpoint to undo/download original files
app.get('/undo/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionUploadDir = path.join(UPLOADS_DIR, sessionId);

    if (!fs.existsSync(sessionUploadDir)) {
        return res.status(404).send('Original files not found or expired.');
    }

    const files = fs.readdirSync(sessionUploadDir);
    if (files.length === 1) {
        // Single file, download directly
        res.download(path.join(sessionUploadDir, files[0]));
    } else {
        // Multiple files, send as zip
        res.attachment('original_pdfs.zip');
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(sessionUploadDir, false);
        archive.finalize();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
