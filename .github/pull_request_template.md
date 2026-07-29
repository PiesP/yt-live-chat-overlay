# Summary

Explain **what** this pull request changes and **why**.

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal improvement
- [ ] Documentation only

## How to test

Describe how reviewers can verify the change, including relevant npm scripts:

```bash
pnpm verify
pnpm test
```

If tests are not required, briefly explain why.

## Checklist

- [ ] Code, commit messages, and inline comments are written in **English**
- [ ] Documentation follows the established language/style of the files I touched
- [ ] I used configured **path aliases** (no new long relative import chains)
- [ ] I avoided dynamic code execution (`eval`, `new Function`, string-based
      `setTimeout`/`setInterval`)
- [ ] I ran the relevant local checks (`pnpm verify`, focused tests, or explained why not)
- [ ] I ran appropriate local tests for my changes (and explained in this PR
      if I could not)
- [ ] I updated `README.md` if user-visible behavior changed
- [ ] I reviewed the [Security Policy](SECURITY.md) for any
      security-impacting changes
