# Profils CSS Zen Internet

Les outils RDP CSS manipulent le stockage de l’extension officielle Zen Internet déjà installée dans le profil Zen explicitement autorisé. Ils ne téléchargent ni n’installent d’extension. L’extension doit être active et permanente, à la version `3.2.0`, et le serveur doit disposer de `ZEN_RDP_PORT` et `ZEN_RDP_PROFILE` pour ce même profil.

## Outils

### Lire l’état enregistré

`zen_css_profile_status({ domain })` renvoie les noms des fonctionnalités enregistrées dans `styles.website["<domain>.css"]`, ainsi que l’état d’identification de l’extension. Il ne renvoie pas le contenu CSS.

### Vérifier un profil local

`zen_css_profile_verify({ profilePath, domain })` compare les règles ciblées du fichier avec le stockage. Cette commande ne modifie pas le stockage. Elle renvoie `matchesStoredProfile`, les noms des règles divergentes et un état `pageApplication` si les onglets du domaine sont inspectables.

La vérification du stockage confirme uniquement que les règles du fichier sont enregistrées. `pageApplication` distingue les onglets du domaine (`matchedTabs`), ceux qui sont déchargés (`discardedTabs`), ceux qui sont chargés (`loadedTabs`), les candidats RDP (`rdpCandidates`), ceux dont la cible a pu être inspectée (`inspectableTabs`) et ceux dont la feuille correspond (`verifiedTabs`). `verificationState` vaut `no_matching_tabs`, `no_loaded_tabs`, `partial`, `verified`, `unavailable` ou `not_checked`. En cas d’échec de découverte, les compteurs sont `null`, car leur valeur est inconnue.

`verifiedTabs >= 1` confirme la feuille CSS sur au moins une page chargée et inspectée, même si `allTabsVerified` reste `false` parce que d’autres onglets sont déchargés ou non inspectables. `allTabsVerified` ne devient vrai que lorsque tous les onglets du domaine sont chargés, inspectables et vérifiés. `pageEvidence` ne contient que des résultats agrégés des cibles inspectées : le nombre de feuilles correspondantes et, lorsque `.article-content` existe, sa couleur d’arrière-plan calculée et la présence d’une image de fond. Aucun URL, identifiant ou contenu de page n’est renvoyé.

Si `verificationState` vaut `no_loaded_tabs`, ouvrez manuellement un onglet du domaine puis relancez `zen_css_profile_verify` pour obtenir une preuve sur cette page. La vérification et les autres outils n’activent, ne chargent, n’ouvrent et ne naviguent aucun onglet. Une vérification partielle ne signifie pas à elle seule que le stockage diffère du fichier ni que le CSS est incorrect sur les pages chargées; consultez `matchesStoredProfile`, `verifiedTabs` et `inspectionFailures`.

### Importer

`zen_css_profile_import({ profilePath, domain })` attend un JSON contenant exactement une entrée `website["<domain>.css"]`, avec une à vingt fonctionnalités CSS sous forme de chaînes. Le domaine fourni doit correspondre exactement au nom de fichier. Les règles font au plus 512 Kio chacune et ne peuvent pas contenir de directive `@import`.

Avant l’écriture, l’outil vérifie que les réglages globaux de l’extension sont initialisés et valides, puis crée un backup privé sous `$XDG_STATE_HOME/zen-mcp/css-profile-backups/`. Il contient le domaine, les valeurs antérieures des fonctionnalités ciblées et les valeurs importées; il ne copie pas le catalogue complet ni les autres données du profil. Le chemin de sauvegarde figure dans la réponse et doit être conservé pour une restauration.

L’import fusionne les seules fonctionnalités nommées dans la clé `styles`, par une transaction atomique. Il préserve les autres domaines, les autres fonctionnalités, les mappings, les réglages globaux et les switches existants, y compris les valeurs `false` et les switches absents. Il émet l’événement `storage.onChanged`, actualise les onglets déjà ouverts qui correspondent au domaine, puis relit le stockage et contrôle la feuille injectée. Évitez d’effectuer des écritures de stockage depuis une autre session RDP pendant l’import ou la restauration; le serveur ne sérialise que ses propres appels.

La réponse sépare `stored`/`readbackVerified` de `pageApplication`. Les compteurs `attemptedLoadedTabs` et `skippedDiscardedTabs` indiquent les appels `applyCSSToTab` tentés sur les onglets chargés et les onglets déchargés ignorés. `refreshedTabs` correspond au nombre d’appels tentés; il ne prouve pas à lui seul l’effet dans le DOM. Si aucun onglet correspondant n’est chargé, le CSS peut être stocké et relu correctement alors que son application dans une page reste non vérifiée.

Si une opération échoue après une mutation possible, le message indique que le stockage peut avoir été modifié et fournit le chemin du backup. Ne relancez pas immédiatement l’import: utilisez `zen_css_profile_status` ou `zen_css_profile_verify` pour relire l’état, puis restaurez avec le backup si nécessaire.

L’extension peut remplacer ultérieurement toute la clé `styles` lors d’une synchronisation du catalogue distant. La version officielle 3.2.0 active cette synchronisation si `autoUpdate` est activé (périodicité annoncée : deux heures). L’import est donc une modification locale du stockage; il ne publie pas le profil et ne garantit pas que les règles importées survivront à une synchronisation future. Si une synchronisation remplace les règles importées, réimportez le profil après celle-ci.

### Restaurer

`zen_css_profile_restore({ backupPath, domain })` restaure uniquement les fonctionnalités présentes dans le backup. Il vérifie le format, l’extension et le domaine de la sauvegarde, puis compare les valeurs CSS actuelles aux valeurs posées par l’import dans la même transaction que la restauration. Si une fonctionnalité ciblée a changé depuis l’import, la restauration est refusée sans écriture. Les changements non ciblés intervenus depuis l’import sont conservés.

Après restauration, l’outil relit le stockage et actualise les onglets correspondants. La réponse indique le chemin du backup, les fonctionnalités restaurées et `pageApplication`.

Si la restauration échoue après une mutation possible, utilisez `zen_css_profile_status` pour relire les noms de fonctionnalités et `zen_css_profile_verify({ profilePath, domain })` avec le profil attendu pour comparer les valeurs stockées. La restauration refuse les changements divergents sur les fonctionnalités ciblées.

## Exemples d’arguments pour Korben

Remplacer le chemin du fichier par le chemin absolu réel du profil local.

```json
{"domain":"korben.info"}
```

```json
{"profilePath":"/absolute/path/to/korben.info.styles.json","domain":"korben.info"}
```

```json
{"backupPath":"/absolute/path/from/the/import/response.json","domain":"korben.info"}
```

Ces arguments correspondent respectivement à `zen_css_profile_status`, `zen_css_profile_verify` ou `zen_css_profile_import`, puis `zen_css_profile_restore`.

## Test d’intégration isolé

Le test installe une copie binaire identique du XPI dans un profil temporaire et utilise uniquement des domaines fixture. Il ne lance pas le profil personnel.

```sh
ZEN_INTERNET_CSS_XPI="/absolute/path/to/official/Zen-Internet-3.2.0.xpi" npm run test:css-profile-integration
```
