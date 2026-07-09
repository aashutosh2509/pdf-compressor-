const dropArea = document.getElementById('drop-area');
const fileElem = document.getElementById('fileElem');
const fileList = document.getElementById('file-list');
const compressBtn = document.getElementById('compress-btn');
const loading = document.getElementById('loading');
const resultsSection = document.getElementById('results-section');
const downloadLink = document.getElementById('download-link');
const undoLink = document.getElementById('undo-link');

let selectedFiles = [];

// Drag and drop events
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, () => dropArea.classList.add('highlight'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, () => dropArea.classList.remove('highlight'), false);
});

dropArea.addEventListener('drop', handleDrop, false);
fileElem.addEventListener('change', handleFiles, false);

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles({ target: { files } });
}

function handleFiles(e) {
    const files = [...e.target.files];
    // Filter out non-PDFs
    const pdfs = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    
    if (pdfs.length === 0) {
        alert('Please select valid PDF files.');
        return;
    }

    selectedFiles = pdfs;
    updateFileList();
    compressBtn.disabled = false;
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function updateFileList() {
    fileList.innerHTML = '';
    selectedFiles.forEach(file => {
        const item = document.createElement('div');
        item.className = 'file-item';
        
        const nameSpan = document.createElement('span');
        nameSpan.textContent = file.name;
        
        const sizeSpan = document.createElement('span');
        sizeSpan.textContent = formatBytes(file.size);
        sizeSpan.style.color = 'var(--text-muted)';
        
        item.appendChild(nameSpan);
        item.appendChild(sizeSpan);
        fileList.appendChild(item);
    });
}

compressBtn.addEventListener('click', async () => {
    if (selectedFiles.length === 0) return;

    // Get selected quality
    const quality = document.querySelector('input[name="quality"]:checked').value;
    
    // Generate a unique session ID for this compression task
    const sessionId = uuidv4();
    
    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('quality', quality);
    
    selectedFiles.forEach(file => {
        formData.append('pdfs', file);
    });

    // UI Updates
    compressBtn.classList.add('hidden');
    dropArea.style.display = 'none';
    document.querySelector('.options-section').style.display = 'none';
    loading.classList.remove('hidden');

    try {
        const response = await fetch('/compress', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error('Compression failed');
        }

        const result = await response.json();
        
        // Setup download links
        downloadLink.href = `/download/${result.sessionId}`;
        undoLink.href = `/undo/${result.sessionId}`;
        
        // Display stats
        const statsDiv = document.getElementById('compression-stats');
        const origSize = formatBytes(result.originalSize);
        const compSize = formatBytes(result.compressedSize);
        const savedPercent = result.originalSize > 0 
            ? Math.round(((result.originalSize - result.compressedSize) / result.originalSize) * 100) 
            : 0;
            
        if (result.originalSize === result.compressedSize || savedPercent <= 0) {
            statsDiv.innerHTML = `<strong>Size:</strong> ${origSize} (No compression occurred. Note: Local testing requires Ghostscript installed to actually compress.)`;
            statsDiv.style.color = '#92400e'; // dark yellow/orange for warning
        } else {
            statsDiv.innerHTML = `<strong>Original Size:</strong> ${origSize} <br> <strong>New Size:</strong> ${compSize} <br> <strong style="color:var(--success);">Saved ${savedPercent}%!</strong>`;
        }

        // Show results
        loading.classList.add('hidden');
        resultsSection.classList.remove('hidden');
        
    } catch (error) {
        console.error('Error:', error);
        alert('An error occurred during compression.');
        // Reset UI
        compressBtn.classList.remove('hidden');
        dropArea.style.display = 'block';
        document.querySelector('.options-section').style.display = 'block';
        loading.classList.add('hidden');
    }
});
