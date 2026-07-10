const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const sharp = require('sharp');

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
        // Use a unique name to prevent collisions if files from different folders have same name
        cb(null, uuidv4() + '-' + file.originalname); 
    }
});

const upload = multer({ storage });

// Compress a single PDF using Ghostscript
function compressPDF(inputPath, outputPath, quality) {
    return new Promise((resolve, reject) => {
        let pdfSettings = '/printer';
        if (quality === 'maximum') pdfSettings = '/prepress';
        if (quality === 'medium') pdfSettings = '/ebook';
        
        // Detect OS and use appropriate Ghostscript command
        let gsCommand = 'gs';
        if (process.platform === 'win32') {
            gsCommand = 'gswin64c'; // Default to PATH if installed there
            const gsBaseDir = 'C:\\Program Files\\gs';
            if (fs.existsSync(gsBaseDir)) {
                const versions = fs.readdirSync(gsBaseDir);
                for (const version of versions) {
                    const exePath = path.join(gsBaseDir, version, 'bin', 'gswin64c.exe');
                    if (fs.existsSync(exePath)) {
                        gsCommand = `"${exePath}"`; // Use absolute path with quotes
                        break;
                    }
                }
            }
        }
        
        const gsCmd = `${gsCommand} -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${pdfSettings} -dNOPAUSE -dQUIET -dBATCH -dAutoRotatePages=/None -dUseCropBox -sOutputFile="${outputPath}" "${inputPath}"`;
        
        exec(gsCmd, (error, stdout, stderr) => {
            if (error) {
                console.error(`Ghostscript error: ${error.message}`);
                fs.copyFileSync(inputPath, outputPath);
                return resolve(outputPath);
            }
            resolve(outputPath);
        });
    });
}

// Compress images using sharp
async function compressImage(inputPath, outputPath, quality, advancedOpts) {
    const ext = path.extname(inputPath).toLowerCase();
    
    // Determine quality percentage
    let q = 80; // High quality
    if (quality === 'maximum') q = 95;
    if (quality === 'medium') q = 60;
    if (quality === 'extreme') q = 40;

    let sharpInstance = sharp(inputPath);
    let finalOutputPath = outputPath;

    const convertToWebp = advancedOpts && advancedOpts.convertToWebp === 'true';
    const resizeLarge = advancedOpts && advancedOpts.resizeLarge === 'true';

    try {
        if (resizeLarge) {
            const metadata = await sharpInstance.metadata();
            if (metadata.width > 2000 || metadata.height > 2000) {
                sharpInstance = sharpInstance.resize({
                    width: 2000,
                    height: 2000,
                    fit: 'inside',
                    withoutEnlargement: true
                });
            }
        }

        if (convertToWebp && ['.jpg', '.jpeg', '.png'].includes(ext)) {
            finalOutputPath = outputPath.substring(0, outputPath.lastIndexOf('.')) + '.webp';
            await sharpInstance.webp({ quality: q, effort: 6 }).toFile(finalOutputPath);
            return finalOutputPath;
        }

        if (ext === '.jpg' || ext === '.jpeg') {
            await sharpInstance.jpeg({ quality: q, mozjpeg: true }).toFile(finalOutputPath);
        } else if (ext === '.png') {
            if (quality === 'extreme' || quality === 'medium') {
                await sharpInstance.png({ palette: true, quality: q, compressionLevel: 9 }).toFile(finalOutputPath);
            } else {
                await sharpInstance.png({ compressionLevel: 9 }).toFile(finalOutputPath);
            }
        } else if (ext === '.webp') {
            await sharpInstance.webp({ quality: q, effort: 6 }).toFile(finalOutputPath);
        } else {
            // Fallback for unsupported image types
            fs.copyFileSync(inputPath, finalOutputPath);
        }
    } catch (err) {
        console.error('Image compression error:', err);
        fs.copyFileSync(inputPath, outputPath);
        return outputPath;
    }
    return finalOutputPath;
}

// POST endpoint to handle upload and compression
app.post('/compress', upload.array('pdfs'), async (req, res) => {
    try {
        const sessionId = req.body.sessionId;
        const quality = req.body.quality || 'high';
        const files = req.files;
        const paths = [].concat(req.body.paths || []);
        const convertToWebp = req.body.convertToWebp;
        const resizeLarge = req.body.resizeLarge;

        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const sessionUploadDir = path.join(UPLOADS_DIR, sessionId);
        const sessionStructuredDir = path.join(sessionUploadDir, 'structured');
        const sessionCompressDir = path.join(COMPRESSED_DIR, sessionId);

        if (!fs.existsSync(sessionCompressDir)) fs.mkdirSync(sessionCompressDir, { recursive: true });
        if (!fs.existsSync(sessionStructuredDir)) fs.mkdirSync(sessionStructuredDir, { recursive: true });

        let totalOriginalSize = 0;
        files.forEach(f => {
            totalOriginalSize += f.size;
        });

        const processedHashes = new Set();
        let duplicatesRemoved = 0;

        // Process all files
        const compressionPromises = files.map(async (file, index) => {
            const relPath = paths[index] || file.originalname;
            const inputPath = path.join(sessionUploadDir, file.filename);
            const outputPath = path.join(sessionCompressDir, relPath);
            const structuredPath = path.join(sessionStructuredDir, relPath);

            // Hash the file to detect exact duplicates
            const fileBuffer = fs.readFileSync(inputPath);
            const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

            if (processedHashes.has(hash)) {
                duplicatesRemoved++;
                // Skip processing and writing this file to output
                return null;
            }
            processedHashes.add(hash);

            // Ensure directories exist
            [path.dirname(outputPath), path.dirname(structuredPath)].forEach(d => {
                if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            });

            // Save original structured file for Undo zip
            fs.copyFileSync(inputPath, structuredPath);

            const ext = path.extname(relPath).toLowerCase();
            if (ext === '.pdf') {
                await compressPDF(inputPath, outputPath, quality);
            } else if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
                return await compressImage(inputPath, outputPath, quality, { convertToWebp, resizeLarge });
            } else {
                fs.copyFileSync(inputPath, outputPath);
            }
            return outputPath;
        });

        const outputPaths = await Promise.all(compressionPromises);
        const validOutputPaths = outputPaths.filter(p => p !== null);

        let totalCompressedSize = 0;
        validOutputPaths.forEach(p => {
            if (fs.existsSync(p)) {
                totalCompressedSize += fs.statSync(p).size;
            }
        });

        res.json({ 
            success: true, 
            message: 'Files compressed successfully',
            sessionId: sessionId,
            originalSize: totalOriginalSize,
            compressedSize: totalCompressedSize,
            duplicatesRemoved: duplicatesRemoved
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal server error during compression' });
    }
});

function sendZipOrFile(dirPath, res, attachmentName) {
    if (!fs.existsSync(dirPath)) {
        return res.status(404).send('Files not found or expired.');
    }
    const files = fs.readdirSync(dirPath);
    // If it's a single file and not a directory, just send it
    if (files.length === 1 && !fs.statSync(path.join(dirPath, files[0])).isDirectory()) {
        res.download(path.join(dirPath, files[0]));
    } else {
        res.attachment(attachmentName);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        archive.directory(dirPath, false);
        archive.finalize();
    }
}

// GET endpoint to download compressed files (as a zip)
app.get('/download/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionCompressDir = path.join(COMPRESSED_DIR, sessionId);
    sendZipOrFile(sessionCompressDir, res, 'compressed_files.zip');
});

// GET endpoint to undo/download original files
app.get('/undo/:sessionId', (req, res) => {
    const sessionId = req.params.sessionId;
    const sessionStructuredDir = path.join(UPLOADS_DIR, sessionId, 'structured');
    sendZipOrFile(sessionStructuredDir, res, 'original_files.zip');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
