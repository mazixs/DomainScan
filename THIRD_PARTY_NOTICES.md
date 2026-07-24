# Third-party notices

## Public Suffix List

DomainScan bundles a generated snapshot of the
[Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat), including its ICANN and
PRIVATE sections, to determine registrable-domain boundaries without making runtime network
requests.

- Snapshot: `third_party/publicsuffix/public_suffix_list.dat`
- Generated runtime data: `src/lib/psl-data.js`
- License: Mozilla Public License 2.0
- License text: `third_party/publicsuffix/LICENSE`

The rest of DomainScan remains licensed under the repository's MIT License. MPL-2.0 applies to the
Public Suffix List snapshot and the generated file derived from it.
