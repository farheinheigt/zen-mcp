# Validation — 26 octobre 2026

Mode 2. Branche locale : `feat/native-organization`. Base amont : `76aa1e7` (1.2.3).
Version locale : `1.3.0-local.1`.

## Résultats observés

- `npm test` : 4 tests unitaires réussis (validation, framing UTF-8, trames invalides, sérialisation après erreur).
- `npm run test:integration` : 49 vérifications via MCP et 27 vérifications complémentaires réussies.
- Le même serveur a alterné appels BiDi et natifs, y compris des demandes concurrentes sérialisées.
- Profil réel différent de celui autorisé : refus avant exécution privilégiée.
- Fusion/suppression avec deux fenêtres : refus confirmé.
- Redémarrage du profil : comparaison exacte des espaces, identifiants/URL/épinglage des 10 pages synthétiques, des 2 dossiers et des 2 Splits conservés. Seuls le titre chargé et l'espace actif sont exclus de la comparaison.
- `npm audit --omit=dev` : aucune vulnérabilité connue signalée après actualisation du verrou de dépendances.
- `node --check` sur les modules et le serveur ; `git diff --check` : réussite.
- `npm pack --dry-run --json` : les modules natifs et la spécification sont inclus ; aucun profil, journal ou fichier de test n'est empaqueté.
- Relecture statique indépendante : risque de perte entre fenêtres corrigé par refus explicite ; aucun blocage restant dans la relecture ciblée.

## Isolation

Les tests lancent exclusivement `/Applications/Zen.app/Contents/MacOS/zen` avec `--headless --no-remote --profile <dossier neuf sous .test-runtime>`, Marionette sur le port local 2839 et BiDi sur 9339. Aucune donnée du profil personnel n'est copiée. Le runner arrête exclusivement le processus qu'il a lancé. Tous les processus de test ont été arrêtés en fin de validation.

Version testée : Zen 1.23.4b, Gecko 158.0.1, macOS Apple Silicon.

Dernière exécution complète : `.test-runtime/integration-1792971418497`, conservée localement et ignorée par Git.

## Limites

Les opérations sur plusieurs fenêtres sont volontairement refusées pour les fusions/suppressions d'espaces ; les autres commandes natives ciblent la fenêtre la plus récente du profil autorisé. Les essentiels et éléments de dossiers dynamiques sont protégés. Les opérations internes ne sont pas transactionnelles ; la source d'une fusion est conservée si un contrôle de préservation échoue. Les API internes peuvent changer avec une nouvelle version de Zen.

Le fork reste local ; aucune configuration MCP personnelle, aucun binaire Zen et aucun profil personnel n'ont été modifiés par ce chantier. Les commandes natives restent désactivées sans configuration explicite des deux variables de profil/port.
