# @profullstack/outreachgraph

`og`, the [OutreachGraph](https://outreachgraph.com) command line. It is a client of the
`/api/v1` API and nothing else: the policy engine runs server-side, so every action goes
through the same gates as the web app.

## Install

```bash
curl -fsSL https://outreachgraph.com/install.sh | sh
```

or with a package manager (Node >= 20, or Bun):

```bash
npm install -g @profullstack/outreachgraph
bun add -g @profullstack/outreachgraph
```

## Configure

Create an API key in OutreachGraph under Settings, then:

```bash
export OUTREACHGRAPH_API_URL=https://outreachgraph.com
export OUTREACHGRAPH_API_TOKEN=og_live_...   # the key names its workspace

og today        # the approval queue
og prospects    # ranked prospects
og --help       # every command
```
