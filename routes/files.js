/**
 * File Explorer Routes
 * Handles file operations on the local file system
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { verifyToken } = require('./auth');

const router = express.Router();

// Get file type icon
function getFileIcon(filename, isDirectory) {
  if (isDirectory) return '📁';
  
  const ext = path.extname(filename).toLowerCase();
  const iconMap = {
    '.txt': '📄', '.md': '📝', '.js': '🟨', '.ts': '🔷', '.py': '🐍',
    '.sh': '⚙️', '.json': '📋', '.html': '🌐', '.css': '🎨',
    '.jpg': '🖼️', '.jpeg': '🖼️', '.png': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
    '.pdf': '📕', '.zip': '📦', '.7z': '📦', '.rar': '📦',
    '.exe': '⚡', '.mp3': '🎵', '.mp4': '🎬', '.mkv': '🎬',
    '.docx': '📘', '.xlsx': '📗', '.pptx': '📙', '.iso': '💿'
  };
  return iconMap[ext] || '📄';
}

// GET /api/files/roots - List available root paths
router.get('/roots', verifyToken, async (req, res) => {
  try {
    const roots = [
      { name: 'Home', path: os.homedir(), icon: '🏠' }
    ];
    
    const folders = ['Downloads', 'Documents', 'Desktop', 'Pictures', 'Videos'];
    const icons = { Downloads: '⬇️', Documents: '📄', Desktop: '🖥️', Pictures: '🖼️', Videos: '🎬' };
    
    for (const folder of folders) {
      const folderPath = path.join(os.homedir(), folder);
      if (fs.existsSync(folderPath)) {
        roots.push({ name: folder, path: folderPath, icon: icons[folder] });
      }
    }
    
    for (const drive of ['C', 'D', 'E', 'F']) {
      try {
        const drivePath = `${drive}:\\`;
        if (fs.existsSync(drivePath)) {
          roots.push({ name: `${drive}: Drive`, path: drivePath, icon: '💾' });
        }
      } catch (e) {}
    }
    
    res.json({ success: true, roots });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/files/list - List files in a directory
router.get('/list', verifyToken, async (req, res) => {
  try {
    let targetPath = req.query.path || os.homedir();
    if (!targetPath || targetPath === '') targetPath = os.homedir();
    targetPath = path.normalize(targetPath);
    
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ success: false, error: 'Directory not found' });
    }
    
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: 'Path is not a directory' });
    }
    
    let items;
    try { items = fs.readdirSync(targetPath); }
    catch (e) { return res.status(403).json({ success: false, error: 'Access denied' }); }
    
    const files = [];
    for (const item of items) {
      try {
        const itemPath = path.join(targetPath, item);
        const itemStats = fs.statSync(itemPath);
        files.push({
          name: item,
          path: itemPath,
          isDirectory: itemStats.isDirectory(),
          size: itemStats.size,
          modified: itemStats.mtime,
          icon: getFileIcon(item, itemStats.isDirectory())
        });
      } catch (e) {}
    }
    
    files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    
    const parentPath = path.dirname(targetPath);
    res.json({
      success: true,
      currentPath: targetPath,
      parentPath: parentPath !== targetPath ? parentPath : null,
      files
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/files/read - Read file contents
router.get('/read', verifyToken, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ success: false, error: 'File path required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'File not found' });
    
    const stats = fs.statSync(filePath);
    if (stats.size > 10 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'File too large (max 10MB)' });
    }
    
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ success: true, path: filePath, content, size: stats.size });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/files/write - Write content to a file
router.post('/write', verifyToken, async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ success: false, error: 'File path required' });
    
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    
    fs.writeFileSync(filePath, content || '');
    res.json({ success: true, message: 'File saved', path: filePath });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/files/mkdir - Create a directory
router.post('/mkdir', verifyToken, async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ success: false, error: 'Directory path required' });
    if (fs.existsSync(dirPath)) return res.status(400).json({ success: false, error: 'Already exists' });
    
    fs.mkdirSync(dirPath, { recursive: true });
    res.json({ success: true, message: 'Directory created', path: dirPath });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/files/delete - Delete file or directory
router.delete('/delete', verifyToken, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ success: false, error: 'Path required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Not found' });
    
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    
    res.json({ success: true, message: 'Deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/files/download - Download a file
router.get('/download', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ success: false, error: 'Path required' });
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Not found' });
    res.download(filePath);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = { router };