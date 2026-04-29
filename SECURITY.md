# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

If you discover a security vulnerability in this project, please report it via email to **[security@orderful.com](mailto:security@orderful.com)**.

You may also use GitHub's [Private Vulnerability Reporting](https://github.com/orderful/PROJECT_NAME/security/advisories/new) feature on this repository's Security tab.

For our full vulnerability disclosure policy, including scope, safe harbor provisions, and guidelines for security researchers, see: **[orderful.com/security/vulnerability-disclosure](https://www.orderful.com/security/vulnerability-disclosure)**

**Note:** Orderful does not operate a bug bounty program at this time. We do not pay rewards of any kind for vulnerability disclosures.

### What to Include

When reporting a vulnerability, please provide as much of the following as possible:

- Type of vulnerability (e.g., SQL injection, XSS, authentication bypass)
- The affected product, service, or component
- Step-by-step instructions to reproduce the issue
- Proof-of-concept code or screenshots
- Your assessment of the potential impact
- Your contact information for follow-up
- Whether you wish to be publicly acknowledged

### What to Expect

| Step | Timeline |
|------|----------|
| Initial acknowledgment | Within 5 business days |
| Initial assessment and expected resolution timeline | Within 15 business days |
| Resolution notification | Upon fix deployment |

With your permission, we will acknowledge your contribution on our [Security Acknowledgements](https://www.orderful.com/security/acknowledgements) page once the issue is resolved.

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | Yes       |

## Security Best Practices for Contributors

- Never commit secrets, API keys, tokens, or credentials — push protection is enforced on this repo.
- Keep dependencies up to date — Dependabot is configured to open PRs for security updates.
- Sign your commits with GPG or SSH keys.
