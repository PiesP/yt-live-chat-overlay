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
pnpm build
pnpm check
pnpm lint
```

If tests are not required, briefly explain why.

## Checklist

- [ ] Code and comments are written in **English**
- [ ] I used configured **path aliases** (no new long relative import chains)
- [ ] I avoided dynamic code execution (`eval`, `new Function`, string-based
      `setTimeout`/`setInterval`)
- [ ] I ran `pnpm build`
- [ ] I ran appropriate local tests for my changes (and explained in this PR
      if I could not)
- [ ] I updated `README.md` if user-visible behavior changed
- [ ] I reviewed the [Security Policy](.github/SECURITY.md) for any
      security-impacting changes
