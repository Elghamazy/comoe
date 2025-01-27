const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const path = require('path');
const app = express();

// Health check endpoints
app.get('/', (req, res) => {
    res.send('Video compression service is running');
});

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Configure axios defaults
axios.defaults.maxRedirects = 5;
axios.defaults.validateStatus = status => status < 400;

app.get('/compress', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).send('Missing video URL');
    }

    // Track if the client disconnects
    let isClientConnected = true;
    req.on('close', () => {
        isClientConnected = false;
        console.log('Client disconnected');
    });

    let ffmpegCommand = null;

    try {
        // First make a HEAD request to get content info
        const headResponse = await axios({
            method: 'head',
            url: videoUrl,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Range': 'bytes=0-'
            },
            timeout: 5000
        });

        // Get content information
        const contentLength = headResponse.headers['content-length'];
        const contentType = headResponse.headers['content-type'];
        const originalFileName = getFileName(headResponse.headers['content-disposition'], videoUrl);

        // Fetch video stream
        const response = await axios({
            method: 'get',
            url: videoUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Range': 'bytes=0-'
            },
            timeout: 0
        });

        // Set response headers
        const compressedFileName = `compressed_${originalFileName}`;
        res.setHeader('Content-Disposition', `attachment; filename="${compressedFileName}"`);
        res.setHeader('Content-Type', 'video/mp4');

        // Handle input stream errors
        response.data.on('error', (error) => {
            console.error('Input stream error:', error);
            cleanup();
            if (!res.headersSent) {
                res.status(500).send('Error processing video stream');
            }
        });

        // Create FFmpeg command
        ffmpegCommand = ffmpeg(response.data)
            .videoCodec('libx264')
            .audioCodec('aac')
            .size('854x480')
            .outputOptions([
                '-preset fast',
                '-threads 2',
                '-cpu-used 4',
                '-crf 30',
                '-maxrate 1000k',
                '-bufsize 1500k',
                '-movflags frag_keyframe+empty_moov+faststart',
                '-g 30',
                '-sc_threshold 0',
                '-tune fastdecode'
            ])
            .format('mp4')
            .on('start', (commandLine) => {
                console.log('Started FFmpeg with command:', commandLine);
            })
            .on('progress', (progress) => {
                // Only log if we have valid progress data and client is still connected
                if (progress && progress.percent !== undefined && isClientConnected) {
                    const percent = Math.round(progress.percent * 100) / 100;
                    console.log('Processing: ', percent, '% done');
                }
            })
            .on('error', (err, stdout, stderr) => {
                if (isClientConnected) {
                    console.error('FFmpeg error:', err.message);
                    if (stderr) {
                        console.error('FFmpeg stderr:', stderr);
                    }
                    if (!res.headersSent) {
                        res.status(500).send('Compression failed');
                    }
                } else {
                    console.log('FFmpeg process terminated due to client disconnect');
                }
                cleanup();
            })
            .on('end', () => {
                console.log('Compression finished successfully');
                cleanup();
            });

        // Pipe the FFmpeg output to response
        ffmpegCommand.pipe(res, { end: true });

    } catch (error) {
        console.error('Error:', error.message);
        cleanup();
        if (!res.headersSent) {
            res.status(500).send(`Failed to process video: ${error.message}`);
        }
    }

    // Cleanup function
    function cleanup() {
        if (ffmpegCommand) {
            try {
                ffmpegCommand.kill('SIGKILL');
            } catch (e) {
                console.error('Error killing FFmpeg process:', e);
            }
        }
    }
});

// Helper function to extract filename
function getFileName(contentDisposition, url) {
    try {
        if (contentDisposition) {
            const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(contentDisposition);
            if (matches && matches[1]) {
                return matches[1].replace(/['"]/g, '');
            }
        }
        
        const urlPath = new URL(url).pathname;
        let fileName = path.basename(urlPath);
        
        const ext = path.extname(fileName).toLowerCase();
        const videoExts = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv'];
        if (!ext || !videoExts.includes(ext)) {
            fileName += '.mp4';
        }
        
        return fileName;
    } catch (error) {
        return 'video.mp4';
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
        res.status(500).send('Internal server error');
    }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});
