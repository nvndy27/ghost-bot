import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MAX_SVG_BYTES, sanitizeCustomSvg } from '../packages/avatar/svg-sanitizer.ts'

test('sanitizes valid SVG into inert base64 data URL', () => {
  const valid =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" width="80" height="80"><circle cx="40" cy="40" r="30" fill="#418D79"/></svg>'
  const res = sanitizeCustomSvg(valid)
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.ok(res.dataUrl.startsWith('data:image/svg+xml;base64,'))
    assert.ok(res.sanitizedSvg.includes('<circle'))
  }
})

test('rejects adversarial SVG payloads (scripts, event handlers, foreignObject, external refs, DTD, oversized)', () => {
  const adversarialPayloads = [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"><circle cx="10" cy="10" r="5"/></svg>',
    '<svg><circle cx="10" cy="10" r="5" onclick="fetch(\'https://evil.test\')"/></svg>',
    '<svg><foreignObject><body><iframe src="https://evil.test"></iframe></body></foreignObject></svg>',
    '<svg><image href="https://evil.test/x.png"/></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><rect width="10" height="10"/></a></svg>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg><text>&xxe;</text></svg>',
    '<svg><rect width="10" height="10" style="background:url(https://evil.test)"/></svg>',
    '<svg><animate attributeName="x" from="0" to="10"/></svg>',
    `<svg>${'<circle cx="1" cy="1" r="1"/>'.repeat(200)}</svg>`,
    `<svg><path d="M0 0 ${'L1 1 '.repeat(8000)}"/></svg>`,
  ]

  for (const payload of adversarialPayloads) {
    const res = sanitizeCustomSvg(payload)
    assert.equal(res.ok, false, `Expected adversarial payload to be rejected: ${payload.slice(0, 60)}`)
  }
  assert.ok(MAX_SVG_BYTES === 32 * 1024)
})
