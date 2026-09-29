import { parseServers, toolName, splitToolName, isMcpTool, summariseArgs, rankTools, formatListing } from '../out/test/mcpconf.mjs'

let pass = 0, fail = 0
const check = (label, ok, detail = '') => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (ok || !detail ? '' : ' -- ' + detail)); ok ? pass++ : fail++ }

console.log('-- the setting --')
check('empty is no servers, no error', parseServers('').servers.length === 0 && !parseServers('  ').error)
check('not JSON is said', /Not JSON/.test(parseServers('{oops').error))
check('a list, or an object with a servers list', parseServers('[{"name":"a","command":"x"}]').servers.length === 1 && parseServers('{"servers":[{"name":"a","command":"x"}]}').servers.length === 1)
const p = parseServers('[{"name":"My Docs!","url":"https://x/mcp","trusted":true},{"name":"fs","command":"npx","args":["-y","srv"],"env":{"K":1},"enabled":false}]')
check('names are slugged, transports inferred, flags read', p.servers[0].name === 'my-docs' && p.servers[0].transport === 'http' && p.servers[0].trusted && p.servers[1].transport === 'stdio' && p.servers[1].enabled === false && p.servers[1].env.K === '1', JSON.stringify(p))
check('a server needs a name', /no name/.test(parseServers('[{"command":"x"}]').error))
check('a stdio server needs a command', /needs a command/.test(parseServers('[{"name":"a"}]').error))
check('a url must be http(s)', /not http/.test(parseServers('[{"name":"a","url":"ftp://x"}]').error))
check('two of a name is an error', /Two servers/.test(parseServers('[{"name":"a","command":"x"},{"name":"A","command":"y"}]').error))

console.log('\n-- names --')
check('a tool is named by server and tool', toolName('My Docs', 'search') === 'mcp__my-docs__search' && isMcpTool('mcp__a__b') && !isMcpTool('read_file'))
check('and split back', JSON.stringify(splitToolName('mcp__my-docs__search_all')) === JSON.stringify({ server: 'my-docs', tool: 'search_all' }) && splitToolName('read_file') === null)
check('the subject is the first string, else the keys', summariseArgs({ n: 1, query: ' find me ' }) === 'find me' && summariseArgs({ a: 1, b: 2 }) === 'a, b' && summariseArgs({}) === '')

console.log('\n-- finding --')
const tools = [
  { name: 'mcp__fs__read_file', description: 'Read a file from disk', params: ['path'], readOnly: true },
  { name: 'mcp__fs__write_file', description: 'Write a file to disk', params: ['path', 'content'], readOnly: false },
  { name: 'mcp__web__search', description: 'Search the web for pages', params: ['query'], readOnly: true }
]
check('name matches outrank description matches', rankTools('search', tools)[0].name === 'mcp__web__search' && rankTools('write file', tools)[0].name === 'mcp__fs__write_file')
check('nothing matching is empty; an empty query is everything', rankTools('zzz', tools).length === 0 && rankTools('', tools).length === 3)
const listing = formatListing(rankTools('file', tools), tools.length)
check('the listing names each tool, its parameters and whether it only reads', /2 of 3 tools/.test(listing) && /mcp__fs__read_file \(reads only\) — takes path/.test(listing) && /mcp__fs__write_file — takes path, content/.test(listing), listing)
check('no tools says how to get some', /adds servers in Settings/.test(formatListing([], 0)) && /None of the 3 tools match/.test(formatListing([], 3)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
