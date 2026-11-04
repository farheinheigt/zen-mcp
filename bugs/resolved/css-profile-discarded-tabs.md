# ZEN-BUG-001 — Vérification CSS des onglets déchargés

- Statut : résolu
- Détecté après publication de la fonctionnalité CSS profile (`eab3249`).

## Symptôme

Pour le domaine `korben.info`, l’import avait confirmé le stockage et annoncé `refreshedTabs: 34`, tandis que la vérification lisait `matchesStoredProfile: true` et `matchedTabs: 0`. Le premier nombre décrivait les appels de rafraîchissement; le second venait uniquement des descriptors RDP et ne distinguait pas une absence d’onglets de domaine d’onglets déchargés.

## Cause constatée

Le profil Zen Internet contenait 17 onglets `korben.info`, tous signalés `discarded: true` et inactifs. Aucun DOM n’était inspectable sans activer ou charger ces onglets. La liste RDP seule ne décrivait pas cet état du navigateur.

## Correction

La vérification compte les onglets par requête d’URL limitée au domaine et retourne des compteurs sans URL ni contenu. Elle distingue les onglets déchargés, chargés, inspectables et vérifiés. Sur les pages chargées et inspectables seulement, elle peut aussi retourner le résultat de présence de la feuille et, pour le premier `.article-content`, sa couleur d’arrière-plan calculée et la présence booléenne d’une image de fond. Le rafraîchissement ignore les onglets déchargés et expose le nombre ignoré. Aucun onglet n’est activé ou chargé par l’outil.

## Validation

Les tests unitaires couvrent 17 onglets déchargés, aucun onglet correspondant, un mélange chargé/déchargé, la vérification complète et les requêtes de nettoyage RDP. Un test d’intégration CSS exerce le comportement sur profil fixture, avec un onglet chargé et un onglet déchargé.
