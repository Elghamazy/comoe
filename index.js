const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const path = require('path');
const app = express();

// Configure axios defaults
axios.defaults.maxRedirects = 5;
axios.defaults.validateStatus = status => status < 400;

app.get('/compress', async (req, res) => {
    const videoUrl = req.query.url;
    if (!videoUrl) {
        return res.status(400).send('Missing video URL');
    }

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
            maxRedirects: 5,
            validateStatus: status => status < 400
        });

        // Get content information
        const contentLength = headResponse.headers['content-length'];
        const contentType = headResponse.headers['content-type'];
        const originalFileName = getFileName(headResponse.headers['content-disposition'], videoUrl);

        // Now fetch the actual video stream
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
            }
        });

        // Set response headers
        const compressedFileName = `compressed_${originalFileName}`;
        res.setHeader('Content-Disposition', `attachment; filename="${compressedFileName}"`);
        res.setHeader('Content-Type', 'video/mp4');
        
        // If we know the input size, we can estimate output size
        if (contentLength) {
            // Estimate compressed size (very rough estimation)
            const estimatedSize = Math.floor(contentLength * 0.7);
            res.setHeader('X-Original-Size', contentLength);
            res.setHeader('X-Estimated-Size', estimatedSize);
        }

        // Set up error handling for the response stream
        response.data.on('error', (error) => {
            console.error('Input stream error:', error);
            if (!res.headersSent) {
                res.status(500).send('Error processing video stream');
            }
        });

        // Configure FFmpeg with optimized settings for limited resources
        const command = ffmpeg(response.data)
            .videoCodec('libx264')
            .audioCodec('aac')
            // Use a lower resolution to reduce processing load
            .size('854x480')
            .outputOptions([
                // CPU optimization settings
                '-preset fast',     // Fastest encoding, sacrifices some compression
                '-threads 2',            // Limit threads to avoid overloading the system
                '-tile-columns 2',       // Parallel processing optimization
                '-frame-parallel 1',     // Enable frame-parallel processing
                '-cpu-used 4',          // Speed up encoding further
                '-crf 30',              // Slightly lower quality for better performance
                '-maxrate 1500k',       // Limit bitrate
                '-bufsize 2000k',       // Buffer size for rate control
                '-movflags frag_keyframe+empty_moov+faststart', // Optimize for streaming
                '-g 30',                // Keyframe interval
                '-sc_threshold 0',      // Disable scene change detection to save CPU
                '-tune fastdecode'      // Optimize for fast decoding
            ])
            .format('mp4')
            .on('start', (commandLine) => {
                console.log('Started FFmpeg with command:', commandLine);
            })
            .on('progress', (progress) => {
                console.log('Processing: ', progress.percent, '% done');
            })
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', err);
                console.error('FFmpeg stderr:', stderr);
                if (!res.headersSent) {
                    res.status(500).send('Compression failed');
                }
            })
            .on('end', () => {
                console.log('Compression finished');
            });

        // Pipe the FFmpeg output to response
        command.pipe(res, { end: true });

    } catch (error) {
        console.error('Error:', error.message);
        if (!res.headersSent) {
            res.status(500).send(`Failed to process video: ${error.message}`);
        }
    }
});

// Helper function to extract filename from headers or URL
function getFileName(contentDisposition, url) {
    try {
        // Try to get filename from Content-Disposition header
        if (contentDisposition) {
            const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(contentDisposition);
            if (matches && matches[1]) {
                return matches[1].replace(/['"]/g, '');
            }
        }
        
        // Fall back to URL parsing
        const urlPath = new URL(url).pathname;
        let fileName = path.basename(urlPath);
        
        // If no extension or not a video extension, add .mp4
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

// Add basic error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
        res.status(500).send('Internal server error');
    }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
