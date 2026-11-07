# Listen Together (server)

The optional server for [Listen Together](https://github.com/citrus401/spotify-listen-together-2.0). Rooms don't
need it. It's for networks where friends can't connect to each other directly.

See [Using a server instead](https://github.com/citrus401/spotify-listen-together-2.0#using-a-server-instead) for how
to run it or deploy it to Render.

Settings (environment variables):

- `HOST_PASSWORD`: the password for **Request host**. Defaults to `1234`, change it.
- `PORT`: defaults to `3000`.
- `MAX_DELAY`: how long (ms) the server waits for everyone to load a song. Defaults to `5000`.
- `SYNC_INTERVAL`: how often (ms) listeners get the position for drift correction. Defaults to `3000`.

Originally by [FlafyDev](https://github.com/FlafyDev/spotify-listen-together-server), with changes from
[JanitorialMess](https://github.com/JanitorialMess/spotify-listen-together-server).
