# ZEN-002 — Gestion XPI par RDP

Statut : terminé, 4 novembre 2026.

Contrat : [installation et vérification XPI par RDP](../../specifications/extensions-xpi-rdp.md).

Outils MCP `zen_extension_status`, `zen_extension_install` et `zen_extension_verify` livrés. Vérification MCP isolée : `npm test` (6/6). E2E RDP sur profil temporaire : profil incorrect refusé; installation 1.0, no-op, mise à jour 1.1, force reinstall, fermeture/recréation de clients MCP séquentiels sans redémarrage Zen, puis vérification après redémarrage du profil de test. Voir `npm run test:rdp-integration`.
