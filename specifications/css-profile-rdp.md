# Profils CSS Zen Internet par RDP

## Périmètre

Les outils CSS utilisent uniquement l’extension officielle Zen Internet dont l’identifiant est `{91aa3897-2634-4a8a-9092-279db23a7689}` et la version attendue `3.2.0`. Ils passent par le RDP déjà configuré pour le profil explicitement autorisé. Aucun autre transport, profil ou identifiant d’extension n’est sélectionnable.

Un profil JSON doit contenir exactement une entrée dans `website`, nommée `<domaine>.css`, avec une à vingt règles CSS sous forme de chaînes. Les champs `mapping` existants dans le fichier source sont ignorés. Le domaine doit être fourni séparément à l’appel MCP et correspondre exactement au nom de fichier CSS.

## Outils

- `zen_css_profile_status({domain})` lit les noms de fonctionnalités enregistrées pour le domaine et l’état ID/version de l’extension.
- `zen_css_profile_verify({profilePath, domain})` compare les fonctionnalités du fichier avec le stockage de l’extension. Si le contexte d’arrière-plan est disponible, il compte les onglets correspondant au domaine, distingue les onglets déchargés (`discarded`) des onglets chargés et vérifie les onglets de domaine inspectables en lisant uniquement la présence et le contenu de `#zeninternet-styles`. Il n’active et ne charge aucun onglet.
- `zen_css_profile_import({profilePath, domain})` sauvegarde les valeurs précédentes des seules fonctionnalités ciblées, puis fusionne ces fonctionnalités dans `styles.website["<domaine>.css"]` dans une transaction IndexedDB `readwrite` unique. Il préserve les autres domaines, les autres fonctionnalités, les mappings, les réglages globaux et les interrupteurs du domaine. Il émet l’événement de changement standard de l’extension, rafraîchit les onglets déjà ouverts du domaine avec `applyCSSToTab`, puis relit le stockage et vérifie la feuille appliquée.
- `zen_css_profile_restore({backupPath, domain})` restaure uniquement les fonctionnalités décrites dans cette sauvegarde. Il refuse la restauration si leur valeur actuelle diffère de la valeur installée par l’import.

## Sauvegarde et conflits

Les sauvegardes résident sous `$XDG_STATE_HOME/zen-mcp/css-profile-backups`, avec un répertoire privé (`0700`) et des fichiers créés exclusivement (`0600`). Chaque sauvegarde ne contient que le domaine, les CSS ciblées, leurs valeurs précédentes et les valeurs appliquées; elle ne copie pas le catalogue ni les autres données du profil.

L’import relit `styles` dans sa transaction et compare les fonctionnalités ciblées avec le snapshot sauvegardé. Si elles ont changé, l’opération est refusée. Les mises à jour non ciblées déjà présentes sont conservées dans le merge. La transaction écrit uniquement la clé `styles`; aucune clé `transparentZenSettings.*` n’est modifiée.

Avant l’import, le serveur vérifie que les réglages globaux de l’extension contiennent toutes les valeurs par défaut attendues par la version `3.2.0`. Si l’état est incomplet ou mal formé, l’import est refusé avant création de sauvegarde et avant toute écriture; l’extension doit terminer son initialisation normale avant de réessayer.

`pageApplication.verificationState` distingue `no_matching_tabs`, `no_loaded_tabs`, `partial`, `verified`, `unavailable` (échec de découverte) et `not_checked` (profil différent du stockage). `matchedTabs` compte les onglets du domaine, `discardedTabs` ceux qui sont déchargés, `loadedTabs` ceux qui ne le sont pas, `rdpCandidates` les candidats annoncés par RDP, `inspectableTabs` ceux dont le console actor a été acquis, et `verifiedTabs` ceux dont la feuille correspond. Si la découverte échoue, les compteurs d’onglets restent `null`, car ils sont inconnus. `pageEvidence` ne porte que sur les cibles inspectées: nombre de feuilles correspondantes et, si le premier `.article-content` existe, ses seuls `backgroundColor` et booléen `hasBackgroundImage`. Aucun contenu, URL ou identifiant de page n’est renvoyé. `allTabsVerified` n’est vrai que si tous les onglets du domaine sont chargés et inspectables et que leur feuille injectée correspond aux fonctionnalités actives. Les interrupteurs du domaine et les réglages globaux restent inchangés; ils peuvent empêcher l’application CSS même si le stockage correspond au profil. L’import ne navigue pas vers le domaine; `refreshedTabs` reste un compte d’appels `applyCSSToTab`, complété par `attemptedLoadedTabs` et `skippedDiscardedTabs`, et ne prouve pas à lui seul l’application à l’écran. Si un onglet correspondant est déchargé, l’état le signale sans l’activer; il faut l’ouvrir manuellement pour vérifier son DOM.

La synchronisation du catalogue par Zen Internet peut remplacer ultérieurement la clé complète `styles`. L’import ne publie pas le profil et ne garantit pas sa conservation après une mise à jour du catalogue. Si celle-ci remplace les règles importées, l’appelant peut réimporter le profil.

Les CSS sont limitées à 512 Kio par fonctionnalité, les imports `@import` sont refusés, et les domaines ou formes de stockage inconnus provoquent un échec fermé. Les opérations n’exposent ni JavaScript RDP arbitraire ni lecture du contenu des pages.
