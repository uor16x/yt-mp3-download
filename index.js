const express = require('express'),
	dotenv = require('dotenv-safe'),
	path = require('path'),
	fs = require('fs'),
	ytList = require('youtube-playlist'),
	ytDownloader = require('youtube-mp3-downloader'),
	bodyParser = require('body-parser'),
	storagePath = path.resolve(path.join(__dirname, './storage')),
	uuid = require('node-uuid'),
	concurrency = 3

const idParserRegExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/
const idParser = link => {
	const match = link.match(idParserRegExp)
	return (match && match[2].length === 11) ? match[2] : false
}

dotenv.config()
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path,
	ffmpeg = require('fluent-ffmpeg')

process.env['FFMPEG_PATH'] = ffmpegPath

const queue = {}
const app = express()
app.use(bodyParser.json({ limit: '100mb', extended: false }))
app.use((req, res, next) => {
	res.result = function (err, data) {
		if (err) {
			if (res.statusCode === 200) {
				res.status(400)
			}
			data = err
		}
		return data ? res.json(data) : res.end()
	}
	return next()
})
app.get('/song/:name', async (req, res) => {
	if (!req.params.name) {
		return res.result('File location missing')
	}
	return res.sendFile(path.resolve(path.join(storagePath, `${req.params.name}.mp3`)))
})
app.get('/progress/:id', async (req, res, next) => {
	if (!req.params.id) {
		return res.result('Process id missing')
	}
	const _process = queue[req.params.id]
	return res.result(null, _process || 'No such process')
})
app.post('/playlist', async (req, res) => {
	const { id } = req.body
	if (!id) {
		return res.result('Playlist id missing')
	}
	let ids
	try {
		const result = await ytList(`https://www.youtube.com/playlist?list=${id}`, 'url')
		ids = result
			&& result.data
			&& result.data.playlist
			&& result.data.playlist.map(url => idParser(url))
	} catch (err) {
		return res.result(err.message)
	}
	if (ids && ids.length > 0) {
		const processId = await downloadYTSongs(ids)
		return res.result(null, processId)
	} else {
		return res.result('Cant find any songs in playlist')
	}
})
app.post('/songs', async (req, res) => {
	const { ids } = req.body
	if (!ids || !ids.length) {
		return res.result('List of ids is empty')
	}
	const processId = await downloadYTSongs(ids)
	return res.result(null, processId)
})

app.listen(process.env.PORT, () => console.log(`Started on ${process.env.PORT}`))

async function downloadYTSongs(ids) {
	const _downloader = new ytDownloader({
		'ffmpegPath': ffmpegPath,
		"outputPath": storagePath,
		"youtubeVideoQuality": "lowestaudio",
		"queueParallelism": 50
	})
	const processId = uuid.v4()
	const _process = queue[processId] = {
		ids: [ ...ids ],
		remaining: [ ...ids ],
		error: {},
		progress: {},
		done: {},
		queue: []
	}

	_downloader.on('finished', (err, data) => {
		const fileName = uuid.v4()
		const srcFilePath = path.resolve(data.file)
		const destFilePath = path.join('./storage', `${fileName}.mp3`)
		increaseBitrate(srcFilePath, destFilePath).then(() => {
			delete _process.progress[data.videoId]
			_process.done[data.videoId] = {
				name: data.artist && data.title ? `${data.artist} - ${data.title}` : data.videoTitle,
				url: `${process.env.BASE_URL}song/${fileName}`
			}
			const index = _process.queue.indexOf(data.videoId)
			_process.queue.splice(index, 1)
		}, err => {
			console.log(`Cant increase bitrate for ${data.videoTitle}`)
		})
	})

	_downloader.on('error', function (error) {
		_process.error[error.videoId] = error.message
	})

	_downloader.on('progress', function (data) {
		const percentage = data.progress.percentage
		if (percentage === 100) {
			_process.progress[data.videoId] = 'encoding'
		} else {
			_process.progress[data.videoId] = Math.floor(percentage)
		}
	})

	const checkInterval = setInterval(() => {
		if (_process.remaining.length === 0) {
			console.log('Remaining empty')
			clearInterval(checkInterval)
		}
		if (_process.queue.length < concurrency && _process.remaining.length > 0) {
			const id = _process.remaining.shift()
			console.log('Preparing download: ' + id)
			_downloader.download(id)
			setTimeout(() => {
				if (!_process.done[id] && !_process.progress[id] && !_process.error[id]) {
					_process.error[id] = 'Downloading has never been started: 10s timeout reached'
					const index = _process.queue.indexOf(id)
					_process.queue.splice(index, 1)
				}
			}, 10000)
			_process.queue.push(id)
		}
	}, 500)

	return processId
}

async function increaseBitrate(src, dest) {
	return new Promise((resolve, reject) => {
		new ffmpeg({ source: src })
			.audioBitrate(320)
			.withAudioCodec('libmp3lame')
			.toFormat('mp3')
			.outputOptions('-id3v2_version', '4')
			.on('error', err => {
				return reject(err)
			})
			.on('end', () => {
				try {
					fs.unlinkSync(path.resolve(src))
					resolve()
				} catch (err) {
					reject(err)
				}
			})
			.saveToFile(dest)
	})
}

