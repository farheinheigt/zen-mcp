# Installation et vérification XPI par RDP

## Contrat

Les outils `zen_extension_install` et `zen_extension_verify` utilisent exclusivement le Remote Debugging Protocol (RDP) de Gecko. Ils ne passent ni par Marionette ni par BiDi et ne les activent pas implicitement. Le profil doit être fourni explicitement par `ZEN_RDP_PROFILE`, avec `ZEN_RDP_PORT`; le profil réel lu depuis le navigateur doit correspondre au chemin autorisé avant toute mutation. Une cible signalant `navigator.webdriver` est refusée.

L'installation accepte un XPI existant et ses ID, version et SHA-256 attendus. L'ID et la version du manifeste sont vérifiés avant l'installation. L'outil vérifie ensuite l'ID/version déclarés par AddonManager, que l'extension est active et permanente (non temporaire), et le SHA-256 du XPI installé dans `extensions/<id>.xpi`. L'installation répétée de l'artefact identique peut être omise; `force: true` demande une réinstallation. `zen_extension_status` révèle l'ID, version, hash, état actif et permanent de l'extension existante afin que l'appelant puisse refuser un downgrade. Une extension non signée peut être acceptée par les préférences du profil dédié, sans changement de préférence implicite par le MCP.

Les outils ne chargent pas de JavaScript fourni par l'appelant, n'installent pas dans le profil personnel par défaut et ne redémarrent pas le navigateur. Les anciens outils web restent BiDi; l'organisation native reste Marionette et requiert encore sa configuration séparée. Chaque opération reste sérialisée.

## Lancement isolé

`npm run launch-zen` exige `ZEN_RDP_PROFILE` pointant vers un profil dédié existant. Il refuse un profil avec marqueur de verrouillage et un port déjà occupé. Il ne ferme pas les instances existantes. Configurer `ZEN_RDP_PORT` (par défaut 6000) et définir explicitement dans ce profil les préférences nécessaires à RDP et, si nécessaire, à l'installation XPI non signée.

## Vérification

Les tests unitaires couvrent la validation des paramètres, l'isolation du transport et le cadrage RDP. Le test de bout en bout doit installer une première version puis une mise à jour sur profil jetable, vérifier les données après chaque installation et après redémarrage. Aucun test ne doit utiliser ou relancer le profil personnel.
